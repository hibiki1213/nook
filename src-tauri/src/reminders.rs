//! Date-field reminders. A `date` field with `remind: true` marks its records
//! as "due" on the day the date arrives. Two surfaces:
//!
//! - **Sidebar badges** — the UI polls `due_counts` (Tauri command) and shows a
//!   per-app count.
//! - **OS notifications** — a background thread ticks every few minutes and
//!   notifies once per app per day (deduped via the `settings` table, so a
//!   restart doesn't re-notify).
//!
//! "Due" means the date equals **today (local time)**. Overdue records are
//! deliberately not notified — for habit/journal apps that would spam forever.

use anyhow::Result;
use rusqlite::Connection;
use serde::Serialize;

use crate::db;
use crate::models::{AppDefinition, FieldType};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DueApp {
    pub app_id: String,
    pub app_name: String,
    pub count: i64,
}

/// Per-app count of records whose reminded date field(s) equal today.
/// A record matching several reminded fields counts once per field — good
/// enough for a badge.
pub fn due_today(conn: &Connection) -> Result<Vec<DueApp>> {
    let mut stmt = conn.prepare("SELECT id, name, definition FROM apps ORDER BY position, created_at")?;
    let apps = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let mut out = Vec::new();
    for (app_id, app_name, raw) in apps {
        let Ok(def) = serde_json::from_str::<AppDefinition>(&raw) else {
            continue; // malformed definition — skip rather than fail the scan
        };
        let mut count = 0i64;
        for f in &def.fields {
            if !(f.remind && f.field_type == FieldType::Date) {
                continue;
            }
            // Table + generated column exist for any app created through repo.
            // substr() tolerates datetime-ish values; localtime matters or the
            // day would flip at 09:00 JST.
            let sql = format!(
                "SELECT count(*) FROM \"d_{app_id}\" \
                 WHERE substr(\"f_{fid}\", 1, 10) = date('now','localtime')",
                fid = f.id
            );
            match conn.query_row(&sql, [], |r| r.get::<_, i64>(0)) {
                Ok(n) => count += n,
                Err(_) => continue, // table missing → treat as zero
            }
        }
        if count > 0 {
            out.push(DueApp { app_id, app_name, count });
        }
    }
    Ok(out)
}

/// One scheduler pass: notify for newly-due apps (once per app per day).
/// Returns the notifications that should be shown (title, body) so the caller
/// owns the actual OS-notification side effect — keeps this testable.
pub fn collect_notifications(conn: &Connection) -> Result<Vec<(String, String)>> {
    let due = due_today(conn)?;

    // Drop dedupe keys from previous days so the table doesn't grow forever.
    conn.execute(
        "DELETE FROM settings WHERE key LIKE 'notified:%' \
         AND key NOT LIKE 'notified:' || date('now','localtime') || ':%'",
        [],
    )?;

    let mut to_show = Vec::new();
    for d in due {
        let key = format!(
            "notified:{}:{}",
            // key layout: notified:<date>:<app> (date first for the cleanup LIKE)
            today(conn)?,
            d.app_id
        );
        let already: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM settings WHERE key = ?1)",
            [&key],
            |r| r.get(0),
        )?;
        if already {
            continue;
        }
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, '1')",
            [&key],
        )?;
        to_show.push((
            format!("{} — Nook", d.app_name),
            format!("今日が期限のレコードが {} 件あります", d.count),
        ));
    }
    Ok(to_show)
}

fn today(conn: &Connection) -> Result<String> {
    Ok(conn.query_row("SELECT date('now','localtime')", [], |r| r.get(0))?)
}

/// Background scheduler: scan every 5 minutes, forever. Notification failures
/// are logged and never crash the thread.
pub fn run_scheduler(app: tauri::AppHandle) {
    use tauri_plugin_notification::NotificationExt;

    loop {
        match db::open().and_then(|conn| collect_notifications(&conn)) {
            Ok(items) => {
                for (title, body) in items {
                    if let Err(e) = app
                        .notification()
                        .builder()
                        .title(&title)
                        .body(&body)
                        .show()
                    {
                        eprintln!("[nook] notification failed: {e}");
                    }
                }
            }
            Err(e) => eprintln!("[nook] reminder scan failed: {e:#}"),
        }
        std::thread::sleep(std::time::Duration::from_secs(300));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        db::init(&conn).unwrap();
        let def: AppDefinition = serde_json::from_str(
            r#"{
                "id": "todo", "name": "Todo",
                "fields": [
                    {"id":"title","label":"T","type":"text"},
                    {"id":"due","label":"期限","type":"date","remind":true}
                ],
                "views": []
            }"#,
        )
        .unwrap();
        conn.execute(
            "INSERT INTO apps (id, name, icon, definition) VALUES ('todo','Todo',NULL,?1)",
            [serde_json::to_string(&def).unwrap()],
        )
        .unwrap();
        db::ensure_table(&conn, &def).unwrap();
        // One due today, one yesterday, one dateless.
        conn.execute_batch(
            r#"
            INSERT INTO "d_todo" (data) VALUES (json_object('title','a','due',date('now','localtime')));
            INSERT INTO "d_todo" (data) VALUES (json_object('title','b','due',date('now','localtime','-1 day')));
            INSERT INTO "d_todo" (data) VALUES (json_object('title','c'));
            "#,
        )
        .unwrap();
        conn
    }

    #[test]
    fn counts_only_today() {
        let conn = setup();
        let due = due_today(&conn).unwrap();
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].app_id, "todo");
        assert_eq!(due[0].count, 1);
    }

    #[test]
    fn notifies_once_per_day() {
        let conn = setup();
        let first = collect_notifications(&conn).unwrap();
        assert_eq!(first.len(), 1);
        assert!(first[0].1.contains("1 件"));
        // Second pass the same day: deduped.
        let second = collect_notifications(&conn).unwrap();
        assert!(second.is_empty());
    }
}
