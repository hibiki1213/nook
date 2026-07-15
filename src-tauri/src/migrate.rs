//! One-time schema migration: v1 (INTEGER AUTOINCREMENT record ids) → v2
//! (ULID TEXT ids). Runs inside `bootstrap()`, before the HTTP and reminder
//! threads exist, so nothing else can touch the database mid-rewrite.
//!
//! Why ULIDs: record ids must be globally unique before two databases can ever
//! merge (P2P sync). The timestamp prefix of every migrated id is derived from
//! the row's `created_at`, and rows within the same second are numbered by a
//! monotonic generator in old-id order — so `ORDER BY created_at, id` yields
//! exactly the pre-migration order.
//!
//! Relation values (the target record's old integer id, stored inside the
//! `data` JSON) are rewritten through an (app, old id) → ULID map built over
//! *all* apps first. A relation pointing at a row that no longer exists was
//! already dangling; it becomes `null` (the old integer is unresolvable
//! after the rewrite anyway).
//!
//! The whole rewrite is a single IMMEDIATE transaction — any failure rolls
//! back to the untouched v1 file. A plain file copy (`nook.db.backup-v1`) is
//! taken first, and the migration refuses to run without it.

use std::collections::HashMap;
use std::time::{Duration, UNIX_EPOCH};

use anyhow::{anyhow, Context, Result};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde_json::Value;

use crate::db;
use crate::models::{AppDefinition, FieldType};

const VERSION_KEY: &str = "schema_version";
const V2: &str = "2";

/// Bootstrap entry point: decide, back up, migrate.
pub fn run(conn: &mut Connection) -> Result<()> {
    if !needs_migration(conn)? {
        return Ok(());
    }
    backup(conn)?;
    migrate(conn)
}

/// Where the pre-migration snapshot lives (next to the DB itself). Never
/// deleted automatically; shown to the user if the migration fails.
pub fn backup_path() -> Result<std::path::PathBuf> {
    Ok(db::db_path()?.with_file_name("nook.db.backup-v1"))
}

/// The version flag alone is not trusted — it is cross-checked against the
/// actual id column type of the record tables, so a half-state (flag says
/// migrated, tables say otherwise) fails loudly instead of corrupting data.
fn needs_migration(conn: &Connection) -> Result<bool> {
    let flag: Option<String> = conn
        .query_row(
            "SELECT value FROM settings WHERE key = ?1",
            [VERSION_KEY],
            |r| r.get(0),
        )
        .optional()?;
    let old_tables = tables_with_integer_ids(conn)?;

    match flag.as_deref() {
        Some(V2) => {
            if old_tables.is_empty() {
                Ok(false)
            } else {
                Err(anyhow!(
                    "schema_version is 2 but these tables still have integer ids: {} — \
                     restore {} and retry",
                    old_tables.join(", "),
                    backup_path().map(|p| p.display().to_string()).unwrap_or_default()
                ))
            }
        }
        Some(other) => Err(anyhow!("unknown schema_version '{other}'")),
        None => {
            if old_tables.is_empty() {
                // Fresh install (nothing materialized yet) — nothing to rewrite.
                set_version(conn)?;
                Ok(false)
            } else {
                Ok(true)
            }
        }
    }
}

/// Record tables (`d_*`) whose `id` column still has INTEGER affinity.
fn tables_with_integer_ids(conn: &Connection) -> Result<Vec<String>> {
    let mut stmt = conn.prepare(
        r"SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'd\_%' ESCAPE '\'",
    )?;
    let tables = stmt
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let mut old = Vec::new();
    for t in tables {
        let mut info = conn.prepare(&format!("PRAGMA table_info(\"{t}\")"))?;
        let id_type: Option<String> = info
            .query_map([], |r| Ok((r.get::<_, String>(1)?, r.get::<_, String>(2)?)))?
            .filter_map(|r| r.ok())
            .find(|(name, _)| name == "id")
            .map(|(_, ty)| ty);
        if id_type.map(|ty| ty.to_ascii_uppercase().contains("INT")).unwrap_or(false) {
            old.push(t);
        }
    }
    Ok(old)
}

/// Copy the DB file before rewriting it. The WAL is folded into the main file
/// first so the copy is self-contained. An existing backup is never overwritten
/// (it is the oldest good copy if a previous attempt failed after copying).
fn backup(conn: &Connection) -> Result<()> {
    let src = db::db_path()?;
    let dst = backup_path()?;
    if dst.exists() {
        return Ok(());
    }
    conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")?;
    std::fs::copy(&src, &dst)
        .with_context(|| format!("failed to back up {} to {}", src.display(), dst.display()))?;
    Ok(())
}

/// The transactional rewrite. Public for tests (which skip the file backup).
pub fn migrate(conn: &mut Connection) -> Result<()> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;

    // Every registered app definition, parsed up front — an unreadable
    // definition aborts the whole migration before anything is touched.
    let defs: Vec<AppDefinition> = {
        let mut stmt = tx.prepare("SELECT definition FROM apps")?;
        let raws = stmt
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        raws.iter()
            .map(|raw| serde_json::from_str(raw).context("invalid app definition"))
            .collect::<Result<Vec<_>>>()?
    };

    // Tables to rewrite = every d_* table with integer ids. Tables not backed
    // by any definition (orphans) are still rewritten — leaving them behind
    // would trip the flag/reality check on every later launch.
    let old_tables = tables_with_integer_ids(&tx)?;

    // Pass 1 — assign a ULID to every row of every old table, in display order.
    let mut ids: HashMap<(String, i64), String> = HashMap::new();
    let mut counts: HashMap<String, i64> = HashMap::new();
    for table in &old_tables {
        let mut gen = ulid::Generator::new();
        let mut last_ms: u64 = 0;
        let mut n = 0i64;
        let mut stmt = tx.prepare(&format!(
            "SELECT id, created_at FROM \"{table}\" ORDER BY created_at ASC, id ASC"
        ))?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for (old_id, created_at) in rows {
            // Clamp to non-decreasing so the monotonic generator keeps the
            // old-id order even if a created_at is unparseable.
            let ms = sqlite_datetime_to_unix_ms(&created_at).unwrap_or(last_ms).max(last_ms);
            last_ms = ms;
            let ulid = gen
                .generate_from_datetime(UNIX_EPOCH + Duration::from_millis(ms))
                .map_err(|e| anyhow!("ulid generation failed: {e}"))?;
            ids.insert((table.clone(), old_id), ulid.to_string());
            n += 1;
        }
        counts.insert(table.clone(), n);
    }

    // Pass 2 — rebuild each table with TEXT ids, rewriting relation values.
    let mut dangling = 0usize;
    for table in &old_tables {
        // relation fields of THIS table: (field id, target table).
        let relations: Vec<(String, String)> = defs
            .iter()
            .find(|d| &d.table_name() == table)
            .map(|def| {
                def.fields
                    .iter()
                    .filter(|f| f.field_type == FieldType::Relation)
                    .filter_map(|f| f.app.as_ref().map(|a| (f.id.clone(), format!("d_{a}"))))
                    .collect()
            })
            .unwrap_or_default();

        let new = format!("{table}__v2");
        tx.execute(
            &format!(
                "CREATE TABLE \"{new}\" (
                    id TEXT PRIMARY KEY NOT NULL,
                    data TEXT NOT NULL DEFAULT '{{}}',
                    created_at TEXT NOT NULL DEFAULT (datetime('now')),
                    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
                )"
            ),
            [],
        )?;

        let rows: Vec<(i64, String, String, String)> = {
            let mut stmt = tx.prepare(&format!(
                "SELECT id, data, created_at, updated_at FROM \"{table}\""
            ))?;
            let it = stmt.query_map([], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
            })?;
            it.collect::<rusqlite::Result<Vec<_>>>()?
        };
        for (old_id, data, created_at, updated_at) in rows {
            let mut data: Value =
                serde_json::from_str(&data).unwrap_or_else(|_| serde_json::json!({}));
            for (fid, target_table) in &relations {
                if let Some(v) = data.get_mut(fid) {
                    if let Some(old_ref) = v.as_i64() {
                        match ids.get(&(target_table.clone(), old_ref)) {
                            Some(ulid) => *v = Value::String(ulid.clone()),
                            None => {
                                *v = Value::Null;
                                dangling += 1;
                            }
                        }
                    }
                }
            }
            let new_id = ids
                .get(&(table.clone(), old_id))
                .ok_or_else(|| anyhow!("no ULID assigned for {table} row {old_id}"))?;
            tx.execute(
                &format!(
                    "INSERT INTO \"{new}\" (id, data, created_at, updated_at)
                     VALUES (?1, json(?2), ?3, ?4)"
                ),
                params![new_id, serde_json::to_string(&data)?, created_at, updated_at],
            )?;
        }

        tx.execute(&format!("DROP TABLE \"{table}\""), [])?;
        tx.execute(&format!("ALTER TABLE \"{new}\" RENAME TO \"{table}\""), [])?;
    }

    // Re-materialize generated columns + indexes (relation columns come back
    // with TEXT affinity now). SQLite DDL is transactional, so this is still
    // all-or-nothing.
    for def in &defs {
        if old_tables.contains(&def.table_name()) {
            db::ensure_table(&tx, def)?;
        }
    }

    // Verify before committing: row counts and id shape.
    for table in &old_tables {
        let n: i64 =
            tx.query_row(&format!("SELECT count(*) FROM \"{table}\""), [], |r| r.get(0))?;
        if n != counts[table] {
            return Err(anyhow!(
                "row count mismatch after migrating {table}: {} → {n}",
                counts[table]
            ));
        }
        let bad: i64 = tx.query_row(
            &format!("SELECT count(*) FROM \"{table}\" WHERE id IS NULL OR length(id) != 26"),
            [],
            |r| r.get(0),
        )?;
        if bad != 0 {
            return Err(anyhow!("{bad} malformed id(s) after migrating {table}"));
        }
    }

    set_version(&tx)?;
    tx.commit()?;
    if dangling > 0 {
        eprintln!("[nook] migration: cleared {dangling} dangling relation value(s)");
    }
    Ok(())
}

fn set_version(conn: &Connection) -> Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)",
        params![VERSION_KEY, V2],
    )?;
    Ok(())
}

/// Parse SQLite's `datetime('now')` text ("YYYY-MM-DD HH:MM:SS", UTC) into unix
/// milliseconds. Handwritten (days-from-civil) to avoid a chrono dependency.
fn sqlite_datetime_to_unix_ms(s: &str) -> Option<u64> {
    let num = |r: std::ops::Range<usize>| -> Option<i64> { s.get(r)?.parse().ok() };
    let (y, mo, d) = (num(0..4)?, num(5..7)?, num(8..10)?);
    let (h, mi, se) = (num(11..13)?, num(14..16)?, num(17..19)?);
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) {
        return None;
    }
    let y2 = if mo <= 2 { y - 1 } else { y };
    let era = if y2 >= 0 { y2 } else { y2 - 399 } / 400;
    let yoe = y2 - era * 400;
    let doy = (153 * (if mo > 2 { mo - 3 } else { mo + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    let secs = days * 86400 + h * 3600 + mi * 60 + se;
    u64::try_from(secs).ok().map(|s| s * 1000)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a v1-format database: INTEGER AUTOINCREMENT ids, INTEGER-affinity
    /// relation generated columns — exactly what the old ensure_table produced.
    fn old_format_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::init(&conn).unwrap();

        let people = r#"{
            "id":"people","name":"People",
            "fields":[{"id":"name","label":"Name","type":"text"}],
            "views":[{"id":"all","name":"All","type":"table"}]
        }"#;
        let tasks = r#"{
            "id":"tasks","name":"Tasks",
            "fields":[
                {"id":"title","label":"Title","type":"text"},
                {"id":"owner","label":"Owner","type":"relation","app":"people","indexed":true}
            ],
            "views":[{"id":"all","name":"All","type":"table"}]
        }"#;
        for (id, def) in [("people", people), ("tasks", tasks)] {
            conn.execute(
                "INSERT INTO apps (id, name, icon, definition) VALUES (?1, ?1, NULL, ?2)",
                params![id, def],
            )
            .unwrap();
        }

        conn.execute_batch(
            r#"
            CREATE TABLE "d_people" (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                data TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now')),
                "f_name" TEXT GENERATED ALWAYS AS (json_extract(data, '$.name')) VIRTUAL
            );
            CREATE TABLE "d_tasks" (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                data TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now')),
                "f_title" TEXT GENERATED ALWAYS AS (json_extract(data, '$.title')) VIRTUAL,
                "f_owner" INTEGER GENERATED ALWAYS AS (json_extract(data, '$.owner')) VIRTUAL
            );
            CREATE INDEX "ix_tasks_owner" ON "d_tasks" ("f_owner");
            "#,
        )
        .unwrap();

        // Two people; three tasks in the same second (order must survive),
        // one referencing a person that no longer exists (dangling).
        conn.execute_batch(
            r#"
            INSERT INTO "d_people" (id, data, created_at) VALUES
                (1, '{"name":"Hibiki"}', '2026-07-01 10:00:00'),
                (2, '{"name":"Yui"}',    '2026-07-02 11:00:00');
            INSERT INTO "d_tasks" (id, data, created_at) VALUES
                (1, '{"title":"first","owner":1}',  '2026-07-03 09:00:00'),
                (2, '{"title":"second","owner":2}', '2026-07-03 09:00:00'),
                (3, '{"title":"third","owner":99}', '2026-07-03 09:00:00');
            "#,
        )
        .unwrap();
        conn
    }

    fn titles_in_order(conn: &Connection) -> Vec<String> {
        let mut stmt = conn
            .prepare("SELECT json_extract(data,'$.title') FROM \"d_tasks\" ORDER BY created_at ASC, id ASC")
            .unwrap();
        stmt.query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap()
    }

    #[test]
    fn migrates_ids_relations_and_order() {
        let mut conn = old_format_db();
        assert!(needs_migration(&conn).unwrap());
        migrate(&mut conn).unwrap();

        // ids are 26-char ULIDs, counts preserved.
        for (table, want) in [("d_people", 2i64), ("d_tasks", 3i64)] {
            let n: i64 = conn
                .query_row(&format!("SELECT count(*) FROM \"{table}\""), [], |r| r.get(0))
                .unwrap();
            assert_eq!(n, want);
            let bad: i64 = conn
                .query_row(
                    &format!("SELECT count(*) FROM \"{table}\" WHERE length(id) != 26"),
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(bad, 0, "{table} has non-ULID ids");
        }

        // Relations remapped: task "first" points at Hibiki's new ULID.
        let hibiki_id: String = conn
            .query_row(
                "SELECT id FROM \"d_people\" WHERE json_extract(data,'$.name')='Hibiki'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let first_owner: String = conn
            .query_row(
                "SELECT json_extract(data,'$.owner') FROM \"d_tasks\" WHERE json_extract(data,'$.title')='first'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(first_owner, hibiki_id);

        // Dangling relation (owner=99) became null.
        let third_owner: Option<String> = conn
            .query_row(
                "SELECT json_extract(data,'$.owner') FROM \"d_tasks\" WHERE json_extract(data,'$.title')='third'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(third_owner, None);

        // Same-second rows keep their old-id order under the new sort.
        assert_eq!(titles_in_order(&conn), vec!["first", "second", "third"]);

        // ULID order alone (ignoring created_at) also matches — the timestamp
        // prefix + monotonic generator make `ORDER BY id` equivalent here.
        let by_id_only: Vec<String> = {
            let mut stmt = conn
                .prepare("SELECT json_extract(data,'$.title') FROM \"d_tasks\" ORDER BY id ASC")
                .unwrap();
            stmt.query_map([], |r| r.get::<_, String>(0))
                .unwrap()
                .collect::<rusqlite::Result<Vec<_>>>()
                .unwrap()
        };
        assert_eq!(by_id_only, vec!["first", "second", "third"]);

        // Generated columns were re-added; relation column now compares as TEXT.
        let via_generated: i64 = conn
            .query_row(
                "SELECT count(*) FROM \"d_tasks\" WHERE f_owner = ?1",
                [hibiki_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(via_generated, 1);
    }

    #[test]
    fn second_run_is_a_noop() {
        let mut conn = old_format_db();
        migrate(&mut conn).unwrap();
        assert!(!needs_migration(&conn).unwrap());

        // And after `run`-level re-entry the data is untouched.
        let before = titles_in_order(&conn);
        assert!(!needs_migration(&conn).unwrap());
        assert_eq!(titles_in_order(&conn), before);
    }

    #[test]
    fn fresh_db_just_sets_the_flag() {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::init(&conn).unwrap();
        assert!(!needs_migration(&conn).unwrap());
        let v: String = conn
            .query_row("SELECT value FROM settings WHERE key='schema_version'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(v, "2");
    }

    #[test]
    fn flag_reality_mismatch_is_a_hard_error() {
        let conn = old_format_db();
        set_version(&conn).unwrap(); // lie: flag says migrated, tables say v1
        assert!(needs_migration(&conn).is_err());
    }

    #[test]
    fn orphan_tables_are_rewritten_too() {
        let mut conn = old_format_db();
        // A d_ table with no matching apps row (e.g. leftover from a crash).
        conn.execute_batch(
            r#"
            CREATE TABLE "d_orphan" (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                data TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            INSERT INTO "d_orphan" (data) VALUES ('{"x":1}');
            "#,
        )
        .unwrap();
        migrate(&mut conn).unwrap();
        assert!(tables_with_integer_ids(&conn).unwrap().is_empty());
        let id: String = conn
            .query_row("SELECT id FROM \"d_orphan\"", [], |r| r.get(0))
            .unwrap();
        assert_eq!(id.len(), 26);
    }

    /// Pre-release check against a COPY of a real database:
    /// `NOOK_MIGRATE_DB=/path/to/copy.db cargo test migrate_a_real_db_copy -- --ignored --nocapture`
    #[test]
    #[ignore = "manual: needs NOOK_MIGRATE_DB pointing at a copy of a real DB"]
    fn migrate_a_real_db_copy() {
        let path = std::env::var("NOOK_MIGRATE_DB").expect("set NOOK_MIGRATE_DB");
        let mut conn = Connection::open(&path).unwrap();
        crate::db::init(&conn).unwrap();
        if needs_migration(&conn).unwrap() {
            migrate(&mut conn).unwrap();
        }
        assert!(tables_with_integer_ids(&conn).unwrap().is_empty());
        assert!(!needs_migration(&conn).unwrap());
        let apps: i64 = conn.query_row("SELECT count(*) FROM apps", [], |r| r.get(0)).unwrap();
        let ic: String = conn
            .query_row("PRAGMA integrity_check", [], |r| r.get(0))
            .unwrap();
        assert_eq!(ic, "ok");
        eprintln!("migrated OK: {apps} app(s), integrity ok — {path}");
    }

    #[test]
    fn datetime_parser_matches_sqlite() {
        // Cross-check the handwritten parser against SQLite's own strftime.
        let conn = Connection::open_in_memory().unwrap();
        for s in [
            "2026-07-15 11:22:33",
            "2000-01-01 00:00:00",
            "1999-12-31 23:59:59",
            "2024-02-29 12:00:00",
        ] {
            let want: i64 = conn
                .query_row("SELECT strftime('%s', ?1)", [s], |r| {
                    r.get::<_, String>(0).map(|v| v.parse().unwrap())
                })
                .unwrap();
            assert_eq!(
                sqlite_datetime_to_unix_ms(s),
                Some(want as u64 * 1000),
                "mismatch for {s}"
            );
        }
        assert_eq!(sqlite_datetime_to_unix_ms("garbage"), None);
        assert_eq!(sqlite_datetime_to_unix_ms(""), None);
    }
}
