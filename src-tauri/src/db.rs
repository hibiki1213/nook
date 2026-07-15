//! SQLite layer. The database is a single file shared (WAL mode) with the Node
//! MCP server so Claude Desktop can build and populate apps that show up live in
//! the UI.
//!
//! Storage model: every record is a JSON object in the `data` column. For each
//! field in an app's definition we add a VIRTUAL generated column
//! (`json_extract(data, '$.<field>')`) and, when the field is marked indexed, an
//! index on it. Canonical data lives in JSON; the generated columns exist purely
//! to make filtering and sorting fast — this is the "JSON + generated columns"
//! design.

use std::path::PathBuf;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use rusqlite::Connection;

use crate::models::{is_safe_ident, AppDefinition, Field};

/// Fixed, cross-process-predictable path so the Tauri app and the MCP server
/// open the exact same file. Kept in sync with `mcp-server/src/db.ts`.
pub fn db_path() -> Result<PathBuf> {
    let home = std::env::var("HOME").context("HOME not set")?;
    let dir = PathBuf::from(home)
        .join("Library")
        .join("Application Support")
        .join("com.nook.app");
    std::fs::create_dir_all(&dir).context("failed to create app data dir")?;
    Ok(dir.join("nook.db"))
}

/// Open a connection with the pragmas needed for safe multi-process access.
pub fn open() -> Result<Connection> {
    let conn = Connection::open(db_path()?)?;
    // WAL lets the app and the MCP server read/write the same file concurrently;
    // busy_timeout makes writers wait briefly instead of erroring on contention.
    // (journal_mode/foreign_keys go through execute_batch because the PRAGMA
    // returns a row that rusqlite's `execute` would reject.)
    conn.busy_timeout(Duration::from_millis(5000))?;
    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")?;
    Ok(conn)
}

/// Create the app registry + a small key/value settings table. Idempotent.
pub fn init(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS apps (
            id          TEXT PRIMARY KEY,
            name        TEXT NOT NULL,
            icon        TEXT,
            definition  TEXT NOT NULL,
            position    INTEGER NOT NULL DEFAULT 0,
            created_at  TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS settings (
            key    TEXT PRIMARY KEY,
            value  TEXT NOT NULL
        );
        "#,
    )?;
    crate::sync::store::init(conn)?;
    Ok(())
}

/// DDL fragment declaring the generated column that mirrors `field` out of the
/// JSON blob. Identical logic must exist in the MCP server.
fn generated_column_sql(field: &Field) -> Result<String> {
    if !is_safe_ident(&field.id) {
        return Err(anyhow!("unsafe field id: {}", field.id));
    }
    Ok(format!(
        "\"f_{id}\" {aff} GENERATED ALWAYS AS (json_extract(data, '$.{id}')) VIRTUAL",
        id = field.id,
        aff = field.field_type.affinity()
    ))
}

/// Materialize (or migrate) the physical table backing an app. Safe to call on
/// every load: it creates the table if missing and ALTERs in any generated
/// columns / indexes that don't exist yet (e.g. after Claude adds a field).
pub fn ensure_table(conn: &Connection, def: &AppDefinition) -> Result<()> {
    if !is_safe_ident(&def.id) {
        return Err(anyhow!("unsafe app id: {}", def.id));
    }
    let table = def.table_name();

    // NOT NULL is load-bearing: unlike INTEGER PRIMARY KEY, a TEXT PRIMARY KEY
    // still admits NULLs in SQLite unless said otherwise.
    let mut columns = vec![
        "id TEXT PRIMARY KEY NOT NULL".to_string(),
        "data TEXT NOT NULL DEFAULT '{}'".to_string(),
        "created_at TEXT NOT NULL DEFAULT (datetime('now'))".to_string(),
        "updated_at TEXT NOT NULL DEFAULT (datetime('now'))".to_string(),
    ];
    for f in &def.fields {
        columns.push(generated_column_sql(f)?);
    }
    conn.execute(
        &format!("CREATE TABLE IF NOT EXISTS \"{table}\" ({})", columns.join(", ")),
        [],
    )?;

    // Add any generated columns that were introduced after the table was first
    // created. Existing rows automatically get the computed value (NULL if the
    // key is absent) — no data migration needed.
    let existing = existing_columns(conn, &table)?;
    for f in &def.fields {
        let col = format!("f_{}", f.id);
        if !existing.contains(&col) {
            conn.execute(
                &format!(
                    "ALTER TABLE \"{table}\" ADD COLUMN {}",
                    generated_column_sql(f)?
                ),
                [],
            )?;
        }
    }

    // Indexes on the generated columns marked as indexed.
    for f in &def.fields {
        if f.indexed {
            conn.execute(
                &format!(
                    "CREATE INDEX IF NOT EXISTS \"ix_{app}_{fid}\" ON \"{table}\" (\"f_{fid}\")",
                    app = def.id,
                    fid = f.id
                ),
                [],
            )?;
        }
    }
    Ok(())
}

/// Prepare the physical table for a definition change: drop the index and
/// generated column of every field that was removed or changed type, so
/// `ensure_table` can re-add them fresh. Canonical data is the JSON blob, so
/// dropping a generated column never loses record data — re-adding a field
/// with the same id (and a compatible type) resurfaces it.
///
/// Order matters: SQLite refuses to DROP COLUMN while an index references it,
/// so indexes go first.
pub fn reconcile_table(conn: &Connection, old: &AppDefinition, new: &AppDefinition) -> Result<()> {
    let table = old.table_name();
    let existing = existing_columns(conn, &table)?;
    for of in &old.fields {
        let nf = new.field(&of.id);
        let drop_col = match nf {
            None => true,
            Some(nf) => nf.field_type != of.field_type,
        };
        // Also drop a now-stale index when a field merely stops being indexed.
        if drop_col || nf.map(|nf| !nf.indexed).unwrap_or(true) {
            conn.execute(
                &format!("DROP INDEX IF EXISTS \"ix_{}_{}\"", old.id, of.id),
                [],
            )?;
        }
        if drop_col && existing.contains(&format!("f_{}", of.id)) {
            conn.execute(
                &format!("ALTER TABLE \"{table}\" DROP COLUMN \"f_{}\"", of.id),
                [],
            )?;
        }
    }
    Ok(())
}

fn existing_columns(conn: &Connection, table: &str) -> Result<Vec<String>> {
    // table_xinfo (not table_info) so generated columns are included — otherwise
    // we'd try to re-ADD columns that already exist.
    let mut stmt = conn.prepare(&format!("PRAGMA table_xinfo(\"{table}\")"))?;
    let cols = stmt
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(cols)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{Field, FieldType};

    fn test_def() -> AppDefinition {
        serde_json::from_str(
            r#"{
                "id": "test",
                "name": "T",
                "fields": [
                    {"id":"title","label":"Title","type":"text","required":true},
                    {"id":"rating","label":"Rating","type":"select","options":["A","B"],"indexed":true},
                    {"id":"stars","label":"Stars","type":"rating","max":5},
                    {"id":"price","label":"Price","type":"money","currency":"JPY"},
                    {"id":"link","label":"Link","type":"url"},
                    {"id":"labels","label":"Labels","type":"tags","options":["x","y"]},
                    {"id":"author","label":"Author","type":"relation","app":"people"},
                    {"id":"done","label":"Done","type":"checkbox"}
                ],
                "views": []
            }"#,
        )
        .unwrap()
    }

    #[test]
    fn ensure_table_is_idempotent_and_migrates() {
        let conn = Connection::open_in_memory().unwrap();
        init(&conn).unwrap();
        let mut def = test_def();

        // Calling twice must not error (this is exactly the table_info vs
        // table_xinfo duplicate-column bug regression test).
        ensure_table(&conn, &def).unwrap();
        ensure_table(&conn, &def).unwrap();

        conn.execute(
            "INSERT INTO \"d_test\" (id, data) VALUES ('01ARZ3NDEKTSV4RRFFQ69G5FAV', json(?1))",
            [r#"{"title":"hi","rating":"A","stars":4,"price":1200,"link":"https://x","labels":["x","y"],"done":true}"#],
        )
        .unwrap();

        // Numeric generated columns (rating/money) compare as numbers.
        let cheap: i64 = conn
            .query_row("SELECT count(*) FROM \"d_test\" WHERE f_price < 2000 AND f_stars >= 4", [], |r| r.get(0))
            .unwrap();
        assert_eq!(cheap, 1);

        // Add a field after data exists — exercises the ALTER migration path.
        def.fields.push(Field {
            id: "note".into(),
            label: "Note".into(),
            field_type: FieldType::Text,
            required: false,
            options: vec![],
            indexed: false,
            default: None,
            max: None,
            currency: None,
            app: None,
            remind: false,
            multiple: false,
        });
        ensure_table(&conn, &def).unwrap();

        // Query through a generated column + confirm the new column exists.
        let a: i64 = conn
            .query_row("SELECT count(*) FROM \"d_test\" WHERE f_rating = 'A'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(a, 1);
        let cols = existing_columns(&conn, "d_test").unwrap();
        assert!(cols.contains(&"f_note".to_string()));
        assert!(cols.contains(&"f_title".to_string()));
        assert!(cols.contains(&"f_labels".to_string()));
    }

    #[test]
    fn reconcile_drops_removed_and_retyped_columns_without_losing_data() {
        let conn = Connection::open_in_memory().unwrap();
        init(&conn).unwrap();
        let old = test_def();
        ensure_table(&conn, &old).unwrap();
        conn.execute(
            "INSERT INTO \"d_test\" (id, data) VALUES ('01ARZ3NDEKTSV4RRFFQ69G5FAW', json(?1))",
            [r#"{"title":"hi","rating":"A","stars":4}"#],
        )
        .unwrap();

        // New definition: `rating` (indexed select) removed, `stars` retyped
        // rating→text, everything else kept.
        let mut new = test_def();
        new.fields.retain(|f| f.id != "rating");
        for f in &mut new.fields {
            if f.id == "stars" {
                f.field_type = FieldType::Text;
            }
        }
        reconcile_table(&conn, &old, &new).unwrap();
        ensure_table(&conn, &new).unwrap();

        let cols = existing_columns(&conn, "d_test").unwrap();
        assert!(!cols.contains(&"f_rating".to_string()));
        assert!(cols.contains(&"f_stars".to_string())); // re-added with TEXT affinity

        // The JSON kept everything: re-adding `rating` resurfaces the value.
        let back = Field {
            id: "rating".into(),
            label: "Rating".into(),
            field_type: FieldType::Select,
            required: false,
            options: vec!["A".into(), "B".into()],
            indexed: true,
            default: None,
            max: None,
            currency: None,
            app: None,
            remind: false,
            multiple: false,
        };
        let mut resurrected = new.clone();
        resurrected.fields.push(back);
        reconcile_table(&conn, &new, &resurrected).unwrap();
        ensure_table(&conn, &resurrected).unwrap();
        let a: i64 = conn
            .query_row("SELECT count(*) FROM \"d_test\" WHERE f_rating = 'A'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(a, 1);
    }
}
