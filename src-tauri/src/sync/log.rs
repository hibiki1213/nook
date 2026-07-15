//! Recording local writes into the change log. Called from repo.rs inside its
//! write transactions; every function is a no-op when the app is not shared,
//! so unshared apps pay one indexed EXISTS query and nothing else.

use anyhow::Result;
use rusqlite::Connection;
use serde_json::{json, Value};

use super::{clock, store, Change};
use crate::models::AppDefinition;

/// Write one cell into the change log, timestamped now.
fn write(
    conn: &Connection,
    app_id: &str,
    entity: &str,
    entity_id: &str,
    attr: &str,
    value: Option<&Value>,
    tombstone: bool,
) -> Result<()> {
    let c = Change {
        app_id: app_id.to_string(),
        entity: entity.to_string(),
        entity_id: entity_id.to_string(),
        attr: attr.to_string(),
        value: value.map(|v| v.to_string()),
        hlc: clock::next(conn)?,
        actor: store::device_id(conn)?,
        seq: 0, // assigned by put_winner
        tombstone,
    };
    store::put_winner(conn, &c)?;
    Ok(())
}

pub fn record_created(conn: &Connection, app_id: &str, id: &str, data: &Value) -> Result<()> {
    if !store::is_shared(conn, app_id)? {
        return Ok(());
    }
    write(conn, app_id, "record", id, "$exists", Some(&json!(1)), false)?;
    if let Some(obj) = data.as_object() {
        for (k, v) in obj {
            if !v.is_null() {
                write(conn, app_id, "record", id, k, Some(v), false)?;
            }
        }
    }
    Ok(())
}

/// `patch` carries only the keys the caller changed — exactly the LWW cells.
pub fn record_updated(conn: &Connection, app_id: &str, id: &str, patch: &Value) -> Result<()> {
    if !store::is_shared(conn, app_id)? {
        return Ok(());
    }
    if let Some(obj) = patch.as_object() {
        for (k, v) in obj {
            write(conn, app_id, "record", id, k, Some(v), false)?;
        }
    }
    Ok(())
}

pub fn record_deleted(conn: &Connection, app_id: &str, id: &str) -> Result<()> {
    if !store::is_shared(conn, app_id)? {
        return Ok(());
    }
    write(conn, app_id, "record", id, "$exists", None, true)
}

/// Diff two definitions into field/view/meta cells. `old = None` means
/// "everything is new" (the share-bootstrap case).
pub fn definition_changed(
    conn: &Connection,
    app_id: &str,
    old: Option<&AppDefinition>,
    new: &AppDefinition,
) -> Result<()> {
    if !store::is_shared(conn, app_id)? {
        return Ok(());
    }

    // Fields: added/changed → $def, removed → tombstone.
    for f in &new.fields {
        let unchanged = old
            .and_then(|o| o.field(&f.id))
            .map(|of| serde_json::to_value(of).ok() == serde_json::to_value(f).ok())
            .unwrap_or(false);
        if !unchanged {
            write(conn, app_id, "field", &f.id, "$def", Some(&serde_json::to_value(f)?), false)?;
        }
    }
    if let Some(o) = old {
        for of in &o.fields {
            if new.field(&of.id).is_none() {
                write(conn, app_id, "field", &of.id, "$def", None, true)?;
            }
        }
    }

    // Views: same shape.
    for v in &new.views {
        let unchanged = old
            .and_then(|o| o.view(&v.id))
            .map(|ov| serde_json::to_value(ov).ok() == serde_json::to_value(v).ok())
            .unwrap_or(false);
        if !unchanged {
            write(conn, app_id, "view", &v.id, "$def", Some(&serde_json::to_value(v)?), false)?;
        }
    }
    if let Some(o) = old {
        for ov in &o.views {
            if new.view(&ov.id).is_none() {
                write(conn, app_id, "view", &ov.id, "$def", None, true)?;
            }
        }
    }

    // Scalar metadata + orderings (whole-array LWW).
    let metas: [(&str, Value); 5] = [
        ("name", json!(new.name)),
        ("icon", json!(new.icon)),
        ("description", json!(new.description)),
        ("field_order", json!(new.fields.iter().map(|f| &f.id).collect::<Vec<_>>())),
        ("view_order", json!(new.views.iter().map(|v| &v.id).collect::<Vec<_>>())),
    ];
    for (key, val) in metas {
        let old_val: Option<Value> = old.map(|o| match key {
            "name" => json!(o.name),
            "icon" => json!(o.icon),
            "description" => json!(o.description),
            "field_order" => json!(o.fields.iter().map(|f| &f.id).collect::<Vec<_>>()),
            _ => json!(o.views.iter().map(|v| &v.id).collect::<Vec<_>>()),
        });
        if old_val.as_ref() != Some(&val) {
            write(conn, app_id, "meta", key, "$value", Some(&val), false)?;
        }
    }
    Ok(())
}

/// Advertise this device in the share (name shown in the member list).
pub fn announce_member(
    conn: &Connection,
    app_id: &str,
    device_id: &str,
    node_id: &str,
    name: Option<&str>,
) -> Result<()> {
    if !store::is_shared(conn, app_id)? {
        return Ok(());
    }
    write(
        conn,
        app_id,
        "meta",
        &format!("member.{device_id}"),
        "$value",
        Some(&json!({ "node_id": node_id, "name": name })),
        false,
    )
}
