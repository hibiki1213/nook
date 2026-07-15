//! Applying a remote batch: field-level LWW with delete-wins, then a
//! deterministic rebuild of the app definition from the winning cells.
//!
//! Everything happens in ONE immediate transaction (SQLite DDL is
//! transactional, so even reconcile/ensure_table roll back with it) — a batch
//! either fully applies or leaves no trace.

use std::collections::BTreeSet;

use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde_json::Value;

use super::{clock, store, Change};
use crate::db;
use crate::models::{is_safe_ident, AppDefinition, Field, View};

pub struct Applied {
    /// Cells that won and were written (losers and echoes don't count).
    /// Read by tests; production callers only care about `apps`.
    #[allow(dead_code)]
    pub applied: usize,
    /// Apps whose canonical state changed — for UI refresh events.
    pub apps: BTreeSet<String>,
}

/// Apply order: rows must exist before their cells; definitions are rebuilt
/// once at the end regardless, so their relative order is irrelevant.
fn rank(c: &Change) -> u8 {
    match (c.entity.as_str(), c.attr.as_str()) {
        ("record", "$exists") => 0,
        ("record", _) => 1,
        _ => 2,
    }
}

pub fn apply_remote(conn: &mut Connection, changes: &[Change]) -> Result<Applied> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;

    let mut sorted: Vec<&Change> = changes.iter().collect();
    sorted.sort_by_key(|c| rank(c)); // stable: preserves sender seq order per rank

    let mut applied = 0usize;
    let mut apps = BTreeSet::new();
    let mut def_dirty: BTreeSet<String> = BTreeSet::new();
    let mut max_hlc: Option<String> = None;

    for c in sorted {
        // The app id is interpolated into table names — never trust the wire.
        if !is_safe_ident(&c.app_id) || !store::is_shared(&tx, &c.app_id)? {
            eprintln!("[nook] sync: dropping change for unknown/unsafe app '{}'", c.app_id);
            continue;
        }
        if max_hlc.as_deref().map(|m| c.hlc.as_str() > m).unwrap_or(true) {
            max_hlc = Some(c.hlc.clone());
        }

        let cur = store::winner(&tx, &c.app_id, &c.entity, &c.entity_id, &c.attr)?;
        let wins = match &cur {
            None => true,
            Some((h, a, _)) => c.beats(h, a),
        };
        if !wins {
            continue;
        }

        match c.entity.as_str() {
            "record" => apply_record_cell(&tx, c)?,
            "field" | "view" | "meta" => {
                def_dirty.insert(c.app_id.clone());
            }
            other => {
                eprintln!("[nook] sync: dropping change with unknown entity '{other}'");
                continue;
            }
        }
        store::put_winner(&tx, c)?;
        applied += 1;
        apps.insert(c.app_id.clone());
    }

    for app_id in &def_dirty {
        rebuild_definition(&tx, app_id)?;
        refresh_members(&tx, app_id)?;
    }
    if let Some(h) = &max_hlc {
        clock::observe(&tx, h)?;
    }
    tx.commit()?;
    Ok(Applied { applied, apps })
}

/// A minimal record table (no generated columns yet) so record cells can land
/// before the definition has ever been seen. `ensure_table` upgrades it in
/// the definition rebuild.
fn ensure_bare_table(conn: &Connection, app_id: &str) -> Result<()> {
    conn.execute(
        &format!(
            "CREATE TABLE IF NOT EXISTS \"d_{app_id}\" (
                id TEXT PRIMARY KEY NOT NULL,
                data TEXT NOT NULL DEFAULT '{{}}',
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            )"
        ),
        [],
    )?;
    Ok(())
}

fn apply_record_cell(conn: &Connection, c: &Change) -> Result<()> {
    ensure_bare_table(conn, &c.app_id)?;
    let table = format!("d_{}", c.app_id);
    let created_secs = clock::Hlc::ms_of(&c.hlc).unwrap_or(0) / 1000;

    if c.attr == "$exists" {
        if c.tombstone {
            conn.execute(&format!("DELETE FROM \"{table}\" WHERE id = ?1"), [&c.entity_id])?;
        } else {
            conn.execute(
                &format!(
                    "INSERT OR IGNORE INTO \"{table}\" (id, data, created_at)
                     VALUES (?1, '{{}}', datetime(?2, 'unixepoch'))"
                ),
                params![c.entity_id, created_secs],
            )?;
        }
        return Ok(());
    }

    // Field cell. Delete-wins: while the $exists winner is a tombstone, cells
    // are recorded (they might outlive a later re-creation) but the row is
    // never materialized.
    let exists = store::winner(conn, &c.app_id, "record", &c.entity_id, "$exists")?;
    if let Some((_, _, true)) = exists {
        return Ok(());
    }
    conn.execute(
        &format!(
            "INSERT OR IGNORE INTO \"{table}\" (id, data, created_at)
             VALUES (?1, '{{}}', datetime(?2, 'unixepoch'))"
        ),
        params![c.entity_id, created_secs],
    )?;

    let existing: String = conn
        .query_row(
            &format!("SELECT data FROM \"{table}\" WHERE id = ?1"),
            [&c.entity_id],
            |r| r.get(0),
        )
        .context("row vanished mid-merge")?;
    let mut data: Value = serde_json::from_str(&existing).unwrap_or_else(|_| serde_json::json!({}));
    let incoming: Value = match &c.value {
        Some(raw) => serde_json::from_str(raw).unwrap_or(Value::Null),
        None => Value::Null,
    };
    if let Some(obj) = data.as_object_mut() {
        obj.insert(c.attr.clone(), incoming);
    }
    conn.execute(
        &format!(
            "UPDATE \"{table}\" SET data = json(?1), updated_at = datetime('now') WHERE id = ?2"
        ),
        params![serde_json::to_string(&data)?, c.entity_id],
    )?;
    Ok(())
}

/// Deterministically rebuild the app definition from the winning field/view/
/// meta cells, then reconcile the physical table. Every peer holds the same
/// winners, so every peer computes the same definition.
fn rebuild_definition(conn: &Connection, app_id: &str) -> Result<()> {
    // Winning (id, json, hlc) per entity kind.
    let load = |entity: &str| -> Result<Vec<(String, String, String)>> {
        let mut stmt = conn.prepare(
            "SELECT entity_id, value, hlc FROM crdt_changes
             WHERE app_id = ?1 AND entity = ?2 AND tombstone = 0 AND value IS NOT NULL",
        )?;
        let rows = stmt
            .query_map(params![app_id, entity], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    };
    let meta = |key: &str| -> Result<Option<Value>> {
        let raw: Option<String> = conn
            .query_row(
                "SELECT value FROM crdt_changes
                 WHERE app_id = ?1 AND entity = 'meta' AND entity_id = ?2 AND tombstone = 0",
                params![app_id, key],
                |r| r.get(0),
            )
            .optional()?;
        Ok(raw.and_then(|s| serde_json::from_str(&s).ok()))
    };

    // Parse + validate fields. Remote definitions reach DDL via ensure_table,
    // so is_safe_ident/validate here are load-bearing, not cosmetic.
    let mut fields: Vec<(String, Field, String)> = Vec::new(); // (id, field, hlc)
    for (id, raw, hlc) in load("field")? {
        let Ok(f) = serde_json::from_str::<Field>(&raw) else {
            eprintln!("[nook] sync: dropping unparseable field def '{id}'");
            continue;
        };
        if f.id != id || !is_safe_ident(&f.id) || f.validate().is_err() {
            eprintln!("[nook] sync: dropping invalid field def '{id}'");
            continue;
        }
        fields.push((id, f, hlc));
    }
    let mut views: Vec<(String, View, String)> = Vec::new();
    for (id, raw, hlc) in load("view")? {
        let Ok(v) = serde_json::from_str::<View>(&raw) else {
            eprintln!("[nook] sync: dropping unparseable view def '{id}'");
            continue;
        };
        if v.id != id || !is_safe_ident(&v.id) {
            eprintln!("[nook] sync: dropping invalid view def '{id}'");
            continue;
        }
        views.push((id, v, hlc));
    }

    // Order: the LWW order array first, stragglers appended by (hlc, id).
    fn sort_defs<T>(
        mut items: Vec<(String, T, String)>,
        order: &[String],
    ) -> Vec<(String, T, String)> {
        items.sort_by(|a, b| {
            let pa = order.iter().position(|x| *x == a.0);
            let pb = order.iter().position(|x| *x == b.0);
            match (pa, pb) {
                (Some(x), Some(y)) => x.cmp(&y),
                (Some(_), None) => std::cmp::Ordering::Less,
                (None, Some(_)) => std::cmp::Ordering::Greater,
                (None, None) => (a.2.as_str(), a.0.as_str()).cmp(&(b.2.as_str(), b.0.as_str())),
            }
        });
        items
    }
    let order_of = |val: Option<Value>| -> Vec<String> {
        val.and_then(|v| serde_json::from_value::<Vec<String>>(v).ok()).unwrap_or_default()
    };
    let field_order = order_of(meta("field_order")?);
    let view_order = order_of(meta("view_order")?);
    let fields: Vec<Field> =
        sort_defs(fields, &field_order).into_iter().map(|(_, f, _)| f).collect();
    let mut views: Vec<View> =
        sort_defs(views, &view_order).into_iter().map(|(_, v, _)| v).collect();
    // The renderer assumes at least one view; derive a default deterministically.
    if views.is_empty() {
        views.push(serde_json::from_value(serde_json::json!({
            "id": "all", "name": "すべて", "type": "table"
        }))?);
    }

    let old: Option<AppDefinition> = conn
        .query_row("SELECT definition FROM apps WHERE id = ?1", [app_id], |r| {
            r.get::<_, String>(0)
        })
        .optional()?
        .and_then(|raw| serde_json::from_str(&raw).ok());

    let as_str = |v: Option<Value>| v.and_then(|x| x.as_str().map(String::from));
    let def = AppDefinition {
        id: app_id.to_string(),
        name: as_str(meta("name")?)
            .or_else(|| old.as_ref().map(|o| o.name.clone()))
            .unwrap_or_else(|| app_id.to_string()),
        icon: as_str(meta("icon")?).or_else(|| old.as_ref().and_then(|o| o.icon.clone())),
        description: as_str(meta("description")?)
            .or_else(|| old.as_ref().and_then(|o| o.description.clone())),
        fields,
        views,
    };

    if let Some(old) = &old {
        db::reconcile_table(conn, old, &def)?;
    }
    conn.execute(
        "INSERT INTO apps (id, name, icon, definition) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name, icon=excluded.icon,
             definition=excluded.definition, updated_at=datetime('now')",
        params![def.id, def.name, def.icon, serde_json::to_string(&def)?],
    )?;
    ensure_bare_table(conn, app_id)?;
    db::ensure_table(conn, &def)?;
    Ok(())
}

/// Mirror `meta member.*` winners into the share_members table (used for
/// pull targets and the member list UI).
fn refresh_members(conn: &Connection, app_id: &str) -> Result<()> {
    let mut stmt = conn.prepare(
        "SELECT entity_id, value FROM crdt_changes
         WHERE app_id = ?1 AND entity = 'meta' AND entity_id LIKE 'member.%'
           AND tombstone = 0 AND value IS NOT NULL",
    )?;
    let rows: Vec<(String, String)> = stmt
        .query_map([app_id], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (key, raw) in rows {
        let device_id = key.trim_start_matches("member.");
        let Ok(v) = serde_json::from_str::<Value>(&raw) else { continue };
        let Some(node_id) = v.get("node_id").and_then(|x| x.as_str()) else { continue };
        let name = v.get("name").and_then(|x| x.as_str());
        store::upsert_member(conn, app_id, device_id, node_id, name)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::{log, store};
    use serde_json::json;

    const DEF: &str = r#"{
        "id":"tasks","name":"Tasks","icon":"✅",
        "fields":[
            {"id":"title","label":"Title","type":"text"},
            {"id":"status","label":"Status","type":"select","options":["a","b"],"indexed":true}
        ],
        "views":[{"id":"all","name":"All","type":"table"}]
    }"#;

    /// A "node": its own in-memory DB with the tasks app shared.
    fn node() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        crate::db::init(&conn).unwrap();
        let def: AppDefinition = serde_json::from_str(DEF).unwrap();
        conn.execute(
            "INSERT INTO apps (id, name, icon, definition) VALUES (?1,?2,?3,?4)",
            params![def.id, def.name, def.icon, DEF],
        )
        .unwrap();
        crate::db::ensure_table(&conn, &def).unwrap();
        store::start_share(&mut conn, "tasks").unwrap();
        conn
    }

    /// Local write helpers that mimic exactly what repo.rs does.
    fn create(conn: &Connection, id: &str, data: Value) {
        conn.execute(
            "INSERT INTO \"d_tasks\" (id, data) VALUES (?1, json(?2))",
            params![id, data.to_string()],
        )
        .unwrap();
        log::record_created(conn, "tasks", id, &data).unwrap();
    }
    fn update(conn: &Connection, id: &str, patch: Value) {
        let existing: String = conn
            .query_row("SELECT data FROM \"d_tasks\" WHERE id=?1", [id], |r| r.get(0))
            .unwrap();
        let mut merged: Value = serde_json::from_str(&existing).unwrap();
        for (k, v) in patch.as_object().unwrap() {
            merged.as_object_mut().unwrap().insert(k.clone(), v.clone());
        }
        conn.execute(
            "UPDATE \"d_tasks\" SET data=json(?1), updated_at=datetime('now') WHERE id=?2",
            params![merged.to_string(), id],
        )
        .unwrap();
        log::record_updated(conn, "tasks", id, &patch).unwrap();
    }
    fn delete(conn: &Connection, id: &str) {
        conn.execute("DELETE FROM \"d_tasks\" WHERE id=?1", [id]).unwrap();
        log::record_deleted(conn, "tasks", id).unwrap();
    }

    /// One-directional sync: pull everything `to` hasn't seen from `from`.
    fn sync(from: &Connection, to: &mut Connection) {
        let from_dev = store::device_id(from).unwrap();
        let cursor = store::cursor_recv(to, "tasks", &from_dev).unwrap();
        let batch = store::pull_since(from, "tasks", cursor, i64::MAX).unwrap();
        let max = batch.iter().map(|c| c.seq).max().unwrap_or(cursor);
        apply_remote(to, &batch).unwrap();
        store::set_cursor_recv(to, "tasks", &from_dev, max).unwrap();
    }

    /// Canonical state: all records (id → data) + the definition JSON.
    fn dump(conn: &Connection) -> (Vec<(String, Value)>, Value) {
        let mut stmt = conn
            .prepare("SELECT id, data FROM \"d_tasks\" ORDER BY id")
            .unwrap();
        let recs = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    serde_json::from_str::<Value>(&r.get::<_, String>(1)?).unwrap(),
                ))
            })
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        // Normalize through AppDefinition: a rebuilt definition serializes
        // serde defaults (required:false, options:[]) that the original raw
        // JSON omits — semantically identical, so compare the parsed form.
        let def: AppDefinition = serde_json::from_str(
            &conn
                .query_row("SELECT definition FROM apps WHERE id='tasks'", [], |r| {
                    r.get::<_, String>(0)
                })
                .unwrap(),
        )
        .unwrap();
        (recs, serde_json::to_value(def).unwrap())
    }

    #[test]
    fn basic_two_way_convergence() {
        let a = node();
        let mut b = node();
        create(&a, "01AAAAAAAAAAAAAAAAAAAAAAAA", json!({"title":"from a","status":"a"}));
        create(&b, "01BBBBBBBBBBBBBBBBBBBBBBBB", json!({"title":"from b"}));
        let mut a = a;
        sync(&b, &mut a);
        sync(&a, &mut b);
        assert_eq!(dump(&a).0.len(), 2);
        assert_eq!(dump(&a), dump(&b));
    }

    #[test]
    fn same_field_conflict_latest_hlc_wins_everywhere() {
        let mut a = node();
        let mut b = node();
        create(&a, "01AAAAAAAAAAAAAAAAAAAAAAAA", json!({"title":"x","status":"a"}));
        sync(&a, &mut b);

        // Partition: both edit the same field. b edits LAST (its HLC is later
        // because these run sequentially in one process).
        update(&a, "01AAAAAAAAAAAAAAAAAAAAAAAA", json!({"status":"a2"}));
        update(&b, "01AAAAAAAAAAAAAAAAAAAAAAAA", json!({"status":"b2"}));

        sync(&a, &mut b);
        sync(&b, &mut a);
        let (recs, _) = dump(&a);
        assert_eq!(recs[0].1["status"], "b2");
        assert_eq!(dump(&a), dump(&b));
    }

    #[test]
    fn different_fields_merge_without_loss() {
        let mut a = node();
        let mut b = node();
        create(&a, "01AAAAAAAAAAAAAAAAAAAAAAAA", json!({"title":"x","status":"a"}));
        sync(&a, &mut b);

        update(&a, "01AAAAAAAAAAAAAAAAAAAAAAAA", json!({"status":"a2"}));
        update(&b, "01AAAAAAAAAAAAAAAAAAAAAAAA", json!({"title":"renamed"}));

        sync(&a, &mut b);
        sync(&b, &mut a);
        let (recs, _) = dump(&a);
        assert_eq!(recs[0].1["status"], "a2", "a's status edit survived");
        assert_eq!(recs[0].1["title"], "renamed", "b's title edit survived");
        assert_eq!(dump(&a), dump(&b));
    }

    #[test]
    fn delete_wins_over_concurrent_edit() {
        let mut a = node();
        let mut b = node();
        create(&a, "01AAAAAAAAAAAAAAAAAAAAAAAA", json!({"title":"x"}));
        sync(&a, &mut b);

        update(&a, "01AAAAAAAAAAAAAAAAAAAAAAAA", json!({"title":"edited"}));
        delete(&b, "01AAAAAAAAAAAAAAAAAAAAAAAA");

        sync(&a, &mut b);
        sync(&b, &mut a);
        assert_eq!(dump(&a).0.len(), 0, "deleted on a");
        assert_eq!(dump(&b).0.len(), 0, "stays deleted on b despite a's edit");
        assert_eq!(dump(&a), dump(&b));
    }

    #[test]
    fn definition_changes_merge_field_add_and_record_edit() {
        let mut a = node();
        let mut b = node();
        create(&a, "01AAAAAAAAAAAAAAAAAAAAAAAA", json!({"title":"x"}));
        sync(&a, &mut b);

        // a adds a field; b edits a record — both must survive.
        let mut def: AppDefinition = serde_json::from_str(DEF).unwrap();
        let old = def.clone();
        def.fields.push(
            serde_json::from_value(json!({"id":"notes","label":"Notes","type":"textarea"}))
                .unwrap(),
        );
        conn_update_app(&a, &old, &def);
        update(&b, "01AAAAAAAAAAAAAAAAAAAAAAAA", json!({"title":"y"}));

        sync(&a, &mut b);
        sync(&b, &mut a);
        let (recs, def_a) = dump(&a);
        assert_eq!(recs[0].1["title"], "y");
        assert!(def_a["fields"].as_array().unwrap().iter().any(|f| f["id"] == "notes"));
        assert_eq!(dump(&a), dump(&b));

        // The generated column for the new field exists on BOTH nodes.
        for c in [&a, &b] {
            let n: i64 = c
                .query_row(
                    "SELECT count(*) FROM pragma_table_xinfo('d_tasks') WHERE name='f_notes'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(n, 1);
        }
    }

    fn conn_update_app(conn: &Connection, old: &AppDefinition, new: &AppDefinition) {
        crate::db::reconcile_table(conn, old, new).unwrap();
        conn.execute(
            "UPDATE apps SET definition=?1, updated_at=datetime('now') WHERE id=?2",
            params![serde_json::to_string(new).unwrap(), new.id],
        )
        .unwrap();
        crate::db::ensure_table(conn, new).unwrap();
        log::definition_changed(conn, &new.id, Some(old), new).unwrap();
    }

    #[test]
    fn idempotent_and_commutative() {
        let a = node();
        let mut b = node();
        let mut c = node();
        create(&a, "01AAAAAAAAAAAAAAAAAAAAAAAA", json!({"title":"one","status":"a"}));
        create(&a, "01CCCCCCCCCCCCCCCCCCCCCCCC", json!({"title":"two"}));
        delete(&a, "01CCCCCCCCCCCCCCCCCCCCCCCC");

        let batch = store::pull_since(&a, "tasks", 0, i64::MAX).unwrap();

        // Idempotent: applying the same batch twice changes nothing.
        apply_remote(&mut b, &batch).unwrap();
        let once = dump(&b);
        let second = apply_remote(&mut b, &batch).unwrap();
        assert_eq!(second.applied, 0, "re-applied batch must be a full no-op");
        assert_eq!(dump(&b), once);

        // Commutative: reversed order converges to the same state.
        let mut reversed = batch.clone();
        reversed.reverse();
        apply_remote(&mut c, &reversed).unwrap();
        assert_eq!(dump(&c), once);
    }

    #[test]
    fn three_nodes_transitive_delivery() {
        // a → b → c: c never talks to a directly, but must still get a's data.
        let a = node();
        let mut b = node();
        let mut c = node();
        create(&a, "01AAAAAAAAAAAAAAAAAAAAAAAA", json!({"title":"origin a"}));
        sync(&a, &mut b);
        sync(&b, &mut c);
        assert_eq!(dump(&c).0.len(), 1);
        assert_eq!(dump(&c).0[0].1["title"], "origin a");
    }

    #[test]
    fn malicious_app_and_field_ids_are_rejected() {
        let mut b = node();
        let evil_app = Change {
            app_id: "x\"; DROP TABLE apps; --".into(),
            entity: "record".into(),
            entity_id: "01AAAAAAAAAAAAAAAAAAAAAAAA".into(),
            attr: "$exists".into(),
            value: Some("1".into()),
            hlc: "999999999999999-00000".into(),
            actor: "evil".into(),
            seq: 1,
            tombstone: false,
        };
        let stats = apply_remote(&mut b, &[evil_app]).unwrap();
        assert_eq!(stats.applied, 0);

        // A field definition with an unsafe id must not reach ensure_table.
        let evil_field = Change {
            app_id: "tasks".into(),
            entity: "field".into(),
            entity_id: "bad\"col".into(),
            attr: "$def".into(),
            value: Some(r#"{"id":"bad\"col","label":"x","type":"text"}"#.into()),
            hlc: "999999999999999-00000".into(),
            actor: "evil".into(),
            seq: 2,
            tombstone: false,
        };
        apply_remote(&mut b, &[evil_field]).unwrap();
        let def: String = b
            .query_row("SELECT definition FROM apps WHERE id='tasks'", [], |r| r.get(0))
            .unwrap();
        assert!(!def.contains("bad\"col"), "unsafe field id leaked into the definition");
        // And the sane world still stands.
        let n: i64 = b.query_row("SELECT count(*) FROM apps", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
    }

    /// Seeded pseudo-random fuzz: random ops on N nodes, random pairwise syncs,
    /// then a full round-robin — all nodes must converge to identical state.
    #[test]
    fn randomized_convergence() {
        // xorshift64* — deterministic, dependency-free. Failures print the seed.
        struct Rng(u64);
        impl Rng {
            fn next(&mut self) -> u64 {
                let mut x = self.0;
                x ^= x >> 12;
                x ^= x << 25;
                x ^= x >> 27;
                self.0 = x;
                x.wrapping_mul(0x2545F4914F6CDD1D)
            }
            fn below(&mut self, n: u64) -> u64 {
                self.next() % n
            }
        }

        for seed in [1u64, 42, 20260715] {
            let mut rng = Rng(seed);
            let mut nodes: Vec<Connection> = (0..3).map(|_| node()).collect();
            let mut known_ids: Vec<String> = Vec::new();

            for step in 0..120 {
                match rng.below(10) {
                    0..=3 => {
                        // create on a random node (id unique per step, so two
                        // steps can never mint the same ULID-shaped id)
                        let n = rng.below(3) as usize;
                        let id = format!("01{:024}", step * 1000 + rng.below(1000));
                        create(&nodes[n], &id, json!({"title": format!("t{step}"), "status": "a"}));
                        known_ids.push(id);
                    }
                    4..=6 => {
                        if let Some(id) = known_ids.get(rng.below(known_ids.len().max(1) as u64) as usize) {
                            let n = rng.below(3) as usize;
                            let has: bool = nodes[n]
                                .query_row(
                                    "SELECT EXISTS(SELECT 1 FROM \"d_tasks\" WHERE id=?1)",
                                    [id],
                                    |r| r.get(0),
                                )
                                .unwrap();
                            if has {
                                update(&nodes[n], id, json!({"status": format!("s{step}")}));
                            }
                        }
                    }
                    7 => {
                        if let Some(id) = known_ids.get(rng.below(known_ids.len().max(1) as u64) as usize) {
                            let n = rng.below(3) as usize;
                            delete(&nodes[n], id);
                        }
                    }
                    _ => {
                        // random one-way sync between two distinct nodes
                        let from = rng.below(3) as usize;
                        let mut to = rng.below(3) as usize;
                        if from == to {
                            to = (to + 1) % 3;
                        }
                        let (f, t) = if from < to {
                            let (l, r) = nodes.split_at_mut(to);
                            (&l[from], &mut r[0])
                        } else {
                            let (l, r) = nodes.split_at_mut(from);
                            (&r[0], &mut l[to])
                        };
                        sync(f, t);
                    }
                }
            }

            // Final full mesh, twice (so late writers reach everyone).
            for _ in 0..2 {
                for i in 0..3 {
                    for j in 0..3 {
                        if i != j {
                            let (f, t) = if i < j {
                                let (l, r) = nodes.split_at_mut(j);
                                (&l[i], &mut r[0])
                            } else {
                                let (l, r) = nodes.split_at_mut(i);
                                (&r[0], &mut l[j])
                            };
                            sync(f, t);
                        }
                    }
                }
            }

            let d0 = dump(&nodes[0]);
            for (i, n) in nodes.iter().enumerate().skip(1) {
                assert_eq!(dump(n), d0, "node {i} diverged (seed {seed})");
            }
        }
    }
}
