//! Data operations, independent of transport. Both the Tauri commands (for the
//! in-app UI) and the local HTTP API (for the external MCP server) call these —
//! so there is exactly one code path that reads/writes the database.

use anyhow::{anyhow, Context, Result};
use rusqlite::{params, Connection};
use serde_json::{json, Value};

use crate::db;
use crate::models::{is_safe_ident, AppDefinition, Field};
use crate::sync;

fn load_definition(conn: &Connection, app_id: &str) -> Result<AppDefinition> {
    let raw: String = conn
        .query_row("SELECT definition FROM apps WHERE id = ?1", [app_id], |r| {
            r.get(0)
        })
        .with_context(|| format!("app not found: {app_id}"))?;
    serde_json::from_str(&raw).context("invalid app definition")
}

fn row_to_record(row: &rusqlite::Row) -> rusqlite::Result<Value> {
    let id: String = row.get(0)?;
    let data: String = row.get(1)?;
    let created_at: String = row.get(2)?;
    let updated_at: String = row.get(3)?;
    let data: Value = serde_json::from_str(&data).unwrap_or_else(|_| json!({}));
    Ok(json!({ "id": id, "data": data, "created_at": created_at, "updated_at": updated_at }))
}

fn fetch_record(conn: &Connection, table: &str, id: &str) -> Result<Value> {
    conn.query_row(
        &format!("SELECT id, data, created_at, updated_at FROM \"{table}\" WHERE id = ?1"),
        [id],
        row_to_record,
    )
    .context("record not found")
}

// ── App registry ────────────────────────────────────────────────────────────

pub fn list_apps() -> Result<Vec<Value>> {
    let conn = db::open()?;
    let mut stmt =
        conn.prepare("SELECT id, name, icon FROM apps ORDER BY position ASC, created_at ASC")?;
    let rows = stmt
        .query_map([], |r| {
            Ok(json!({
                "id": r.get::<_, String>(0)?,
                "name": r.get::<_, String>(1)?,
                "icon": r.get::<_, Option<String>>(2)?,
            }))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn get_app(app_id: &str) -> Result<Value> {
    let conn = db::open()?;
    Ok(serde_json::to_value(load_definition(&conn, app_id)?)?)
}

pub fn create_app(definition: Value) -> Result<Value> {
    let def: AppDefinition =
        serde_json::from_value(definition).context("invalid app definition")?;
    if !is_safe_ident(&def.id) {
        return Err(anyhow!("app id must match ^[a-z][a-z0-9_]*$: {}", def.id));
    }
    for f in &def.fields {
        f.validate().map_err(|e| anyhow!(e))?;
    }
    let mut conn = db::open()?;
    let tx = conn.transaction()?;
    let old = load_definition(&tx, &def.id).ok();
    let raw = serde_json::to_string(&def)?;
    tx.execute(
        "INSERT INTO apps (id, name, icon, definition) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name, icon=excluded.icon,
             definition=excluded.definition, updated_at=datetime('now')",
        params![def.id, def.name, def.icon, raw],
    )?;
    db::ensure_table(&tx, &def)?;
    sync::log::definition_changed(&tx, &def.id, old.as_ref(), &def)?;
    tx.commit()?;
    sync::notify_change(&def.id);
    Ok(json!({ "id": def.id, "name": def.name, "icon": def.icon }))
}

pub fn add_field(app_id: &str, field: Value) -> Result<Value> {
    let field: Field = serde_json::from_value(field).context("invalid field")?;
    if !is_safe_ident(&field.id) {
        return Err(anyhow!("field id must match ^[a-z][a-z0-9_]*$: {}", field.id));
    }
    field.validate().map_err(|e| anyhow!(e))?;
    let mut conn = db::open()?;
    let tx = conn.transaction()?;
    let old = load_definition(&tx, app_id)?;
    if old.fields.iter().any(|f| f.id == field.id) {
        return Err(anyhow!("field already exists: {}", field.id));
    }
    let mut def = old.clone();
    def.fields.push(field);
    tx.execute(
        "UPDATE apps SET definition = ?1, updated_at = datetime('now') WHERE id = ?2",
        params![serde_json::to_string(&def)?, app_id],
    )?;
    db::ensure_table(&tx, &def)?; // ALTERs in the new generated column + index
    sync::log::definition_changed(&tx, app_id, Some(&old), &def)?;
    tx.commit()?;
    sync::notify_change(app_id);
    Ok(serde_json::to_value(def)?)
}

/// Replace an app's full definition (name / icon / fields / views) and
/// reconcile the physical table (see `db::reconcile_table`). Dropping a field
/// only drops its generated column — the values stay in each record's JSON,
/// so re-adding the field later resurfaces them. UI-only (the app builder);
/// the MCP surface keeps its narrower create_app / add_field vocabulary.
pub fn update_app(app_id: &str, definition: Value) -> Result<Value> {
    let def: AppDefinition =
        serde_json::from_value(definition).context("invalid app definition")?;
    if def.id != app_id {
        return Err(anyhow!("definition id '{}' does not match app '{app_id}'", def.id));
    }
    if !is_safe_ident(&def.id) {
        return Err(anyhow!("app id must match ^[a-z][a-z0-9_]*$: {}", def.id));
    }
    for (i, f) in def.fields.iter().enumerate() {
        if !is_safe_ident(&f.id) {
            return Err(anyhow!("field id must match ^[a-z][a-z0-9_]*$: {}", f.id));
        }
        if def.fields[..i].iter().any(|p| p.id == f.id) {
            return Err(anyhow!("duplicate field id: {}", f.id));
        }
        f.validate().map_err(|e| anyhow!(e))?;
    }
    if def.views.is_empty() {
        return Err(anyhow!("an app needs at least one view"));
    }
    let mut conn = db::open()?;
    let tx = conn.transaction()?;
    let old = load_definition(&tx, app_id)?;
    db::reconcile_table(&tx, &old, &def)?;
    tx.execute(
        "UPDATE apps SET name = ?1, icon = ?2, definition = ?3,
             updated_at = datetime('now') WHERE id = ?4",
        params![def.name, def.icon, serde_json::to_string(&def)?, app_id],
    )?;
    db::ensure_table(&tx, &def)?; // re-adds dropped/new columns + indexes
    sync::log::definition_changed(&tx, app_id, Some(&old), &def)?;
    tx.commit()?;
    sync::notify_change(app_id);
    Ok(serde_json::to_value(def)?)
}

/// Delete an app: drop its physical records table (which also drops its indexes)
/// and remove it from the registry. Destructive — all records are lost. UI-only;
/// deliberately NOT exposed over the MCP/HTTP surface.
pub fn delete_app(app_id: &str) -> Result<Value> {
    if !is_safe_ident(app_id) {
        return Err(anyhow!("invalid app id: {app_id}"));
    }
    let mut conn = db::open()?;
    if sync::store::is_shared(&conn, app_id)? {
        return Err(anyhow!(
            "共有中のアプリは削除できません。先に共有を解除してください"
        ));
    }
    let tx = conn.transaction()?;
    // `app_id` is validated above, so this interpolation is safe.
    tx.execute(&format!("DROP TABLE IF EXISTS \"d_{app_id}\""), [])?;
    let removed = tx.execute("DELETE FROM apps WHERE id = ?1", [app_id])?;
    if removed == 0 {
        return Err(anyhow!("app not found: {app_id}"));
    }
    tx.commit()?;
    Ok(json!({ "deleted": app_id }))
}

// ── Records ─────────────────────────────────────────────────────────────────

pub fn list_records(app_id: &str, view_id: Option<&str>) -> Result<Vec<Value>> {
    let conn = db::open()?;
    let def = load_definition(&conn, app_id)?;
    db::ensure_table(&conn, &def)?;
    let table = def.table_name();

    let mut order = String::from("created_at DESC, id DESC");
    if let Some(vid) = view_id {
        if let Some(view) = def.view(vid) {
            let mut parts = Vec::new();
            for s in &view.sort {
                if def.field(&s.field).is_some() && is_safe_ident(&s.field) {
                    let dir = if s.dir.eq_ignore_ascii_case("desc") { "DESC" } else { "ASC" };
                    parts.push(format!("\"f_{}\" {dir}", s.field));
                }
            }
            if !parts.is_empty() {
                order = parts.join(", ");
            }
        }
    }

    let mut stmt = conn.prepare(&format!(
        "SELECT id, data, created_at, updated_at FROM \"{table}\" ORDER BY {order}"
    ))?;
    let rows = stmt
        .query_map([], row_to_record)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn create_record(app_id: &str, data: Value) -> Result<Value> {
    let mut conn = db::open()?;
    let def = load_definition(&conn, app_id)?;
    db::ensure_table(&conn, &def)?;
    let table = def.table_name();
    let id = ulid::Ulid::new().to_string();
    let tx = conn.transaction()?;
    tx.execute(
        &format!("INSERT INTO \"{table}\" (id, data) VALUES (?1, json(?2))"),
        params![id, serde_json::to_string(&data)?],
    )?;
    sync::log::record_created(&tx, app_id, &id, &data)?;
    let rec = fetch_record(&tx, &table, &id)?;
    tx.commit()?;
    sync::notify_change(app_id);
    Ok(rec)
}

pub fn update_record(app_id: &str, id: &str, data: Value) -> Result<Value> {
    let mut conn = db::open()?;
    let def = load_definition(&conn, app_id)?;
    let table = def.table_name();
    let tx = conn.transaction()?;
    // Merge the provided keys over the existing record.
    let existing: String = tx
        .query_row(&format!("SELECT data FROM \"{table}\" WHERE id = ?1"), [id], |r| r.get(0))
        .context("record not found")?;
    let mut merged: Value = serde_json::from_str(&existing).unwrap_or_else(|_| json!({}));
    if let (Some(base), Some(patch)) = (merged.as_object_mut(), data.as_object()) {
        for (k, v) in patch {
            base.insert(k.clone(), v.clone());
        }
    } else {
        merged = data.clone();
    }
    tx.execute(
        &format!("UPDATE \"{table}\" SET data = json(?1), updated_at = datetime('now') WHERE id = ?2"),
        params![serde_json::to_string(&merged)?, id],
    )?;
    // Only the patched keys are LWW cells — not the whole merged object.
    sync::log::record_updated(&tx, app_id, id, &data)?;
    let rec = fetch_record(&tx, &table, id)?;
    tx.commit()?;
    sync::notify_change(app_id);
    Ok(rec)
}

pub fn delete_record(app_id: &str, id: &str) -> Result<Value> {
    let mut conn = db::open()?;
    let def = load_definition(&conn, app_id)?;
    let table = def.table_name();
    let tx = conn.transaction()?;
    tx.execute(&format!("DELETE FROM \"{table}\" WHERE id = ?1"), [id])?;
    sync::log::record_deleted(&tx, app_id, id)?;
    tx.commit()?;
    sync::notify_change(app_id);
    Ok(json!({ "deleted": id }))
}
