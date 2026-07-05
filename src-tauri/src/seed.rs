//! First-run seed: a task-management app so the UI has something to show before
//! Claude has built anything. Idempotent — keyed on the fixed id `app_tasks`, so
//! re-running never duplicates or clobbers the user's edits.

use anyhow::Result;
use rusqlite::Connection;

use crate::db;
use crate::models::AppDefinition;

const TASKS_DEF: &str = r#"{
  "id": "app_tasks",
  "name": "タスク管理",
  "icon": "✅",
  "description": "個人タスクを管理するサンプルアプリ",
  "fields": [
    { "id": "title",    "label": "タイトル",   "type": "text",     "required": true },
    { "id": "status",   "label": "ステータス", "type": "select",   "options": ["未着手","進行中","完了"], "default": "未着手", "indexed": true },
    { "id": "priority", "label": "優先度",     "type": "select",   "options": ["低","中","高"], "default": "中", "indexed": true },
    { "id": "due",      "label": "期限",       "type": "date",     "indexed": true },
    { "id": "done",     "label": "完了",       "type": "checkbox", "default": false },
    { "id": "notes",    "label": "メモ",       "type": "textarea" }
  ],
  "views": [
    { "id": "all",   "name": "すべて", "type": "table", "columns": ["title","status","priority","due","done"], "sort": [{ "field": "due", "dir": "asc" }] },
    { "id": "board", "name": "ボード", "type": "board", "groupBy": "status" }
  ]
}"#;

pub fn seed(conn: &Connection) -> Result<()> {
    // Seed the sample app at most once — ever. Keyed on a persistent flag (not on
    // the app's existence) so that deleting the sample app makes it stay gone
    // instead of reappearing on the next launch.
    let seeded: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM settings WHERE key = 'seeded')",
        [],
        |r| r.get(0),
    )?;
    if seeded {
        return Ok(());
    }

    // Migration: a DB seeded before the flag existed already has the sample app.
    // Just record the flag (don't re-insert sample rows) and stop.
    let app_exists: bool =
        conn.query_row("SELECT EXISTS(SELECT 1 FROM apps WHERE id = 'app_tasks')", [], |r| {
            r.get(0)
        })?;
    if app_exists {
        mark_seeded(conn)?;
        return Ok(());
    }

    let def: AppDefinition = serde_json::from_str(TASKS_DEF)?;
    conn.execute(
        "INSERT OR IGNORE INTO apps (id, name, icon, definition, position)
         VALUES (?1, ?2, ?3, ?4, 0)",
        rusqlite::params![def.id, def.name, def.icon, TASKS_DEF],
    )?;
    db::ensure_table(conn, &def)?;

    // A couple of example rows so the table/board views aren't empty.
    let table = def.table_name();
    let samples = [
        r#"{"title":"Nook のMVPを触ってみる","status":"進行中","priority":"高","due":"2026-07-03","done":false,"notes":"Claude Desktop からアプリを作ってみる"}"#,
        r#"{"title":"買い物リストを作る","status":"未着手","priority":"低","due":"2026-07-05","done":false,"notes":""}"#,
        r#"{"title":"読書メモアプリをClaudeに作ってもらう","status":"未着手","priority":"中","due":"2026-07-10","done":false,"notes":""}"#,
    ];
    for s in samples {
        conn.execute(
            &format!("INSERT INTO \"{table}\" (data) VALUES (json(?1))"),
            [s],
        )?;
    }
    mark_seeded(conn)?;
    Ok(())
}

/// Record that first-run seeding has happened, so it never runs again.
fn mark_seeded(conn: &Connection) -> Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES ('seeded', '1')",
        [],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn app_exists(conn: &Connection) -> bool {
        conn.query_row("SELECT EXISTS(SELECT 1 FROM apps WHERE id='app_tasks')", [], |r| {
            r.get(0)
        })
        .unwrap()
    }

    #[test]
    fn seeds_once_and_deletion_sticks() {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::init(&conn).unwrap();

        // First run seeds the sample app + rows.
        seed(&conn).unwrap();
        assert!(app_exists(&conn));

        // User deletes the sample app.
        conn.execute("DROP TABLE \"d_app_tasks\"", []).unwrap();
        conn.execute("DELETE FROM apps WHERE id='app_tasks'", []).unwrap();
        assert!(!app_exists(&conn));

        // Next launch must NOT bring it back (the 'seeded' flag is set).
        seed(&conn).unwrap();
        assert!(!app_exists(&conn));
    }

    #[test]
    fn migrates_preexisting_db_without_duplicating_rows() {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::init(&conn).unwrap();

        // Simulate a DB seeded before the flag existed: app present, no flag.
        let def: AppDefinition = serde_json::from_str(TASKS_DEF).unwrap();
        conn.execute(
            "INSERT INTO apps (id, name, icon, definition) VALUES (?1,?2,?3,?4)",
            rusqlite::params![def.id, def.name, def.icon, TASKS_DEF],
        )
        .unwrap();
        crate::db::ensure_table(&conn, &def).unwrap();
        conn.execute("INSERT INTO \"d_app_tasks\" (data) VALUES (json('{\"title\":\"x\"}'))", [])
            .unwrap();

        // Running seed records the flag but must not add sample rows.
        seed(&conn).unwrap();
        let rows: i64 = conn
            .query_row("SELECT count(*) FROM \"d_app_tasks\"", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 1, "seed re-inserted sample rows into an existing app");
        let seeded: bool = conn
            .query_row("SELECT EXISTS(SELECT 1 FROM settings WHERE key='seeded')", [], |r| r.get(0))
            .unwrap();
        assert!(seeded);
    }
}
