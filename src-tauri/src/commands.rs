//! Tauri commands for the in-app React UI. Thin wrappers over `repo` — the same
//! operations the local HTTP API exposes to the MCP server.

use serde::Serialize;
use serde_json::Value;

use crate::repo;

/// Error wrapper so `?` works in commands and the message reaches the frontend.
#[derive(Debug)]
pub struct AppError(anyhow::Error);

impl<E: Into<anyhow::Error>> From<E> for AppError {
    fn from(e: E) -> Self {
        AppError(e.into())
    }
}

impl Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        s.serialize_str(&format!("{:#}", self.0))
    }
}

type CmdResult<T> = std::result::Result<T, AppError>;

#[tauri::command]
pub fn list_apps() -> CmdResult<Vec<Value>> {
    Ok(repo::list_apps()?)
}

#[tauri::command]
pub fn get_app(app_id: String) -> CmdResult<Value> {
    Ok(repo::get_app(&app_id)?)
}

#[tauri::command]
pub fn create_app(definition: Value) -> CmdResult<Value> {
    Ok(repo::create_app(definition)?)
}

#[tauri::command]
pub fn add_field(app_id: String, field: Value) -> CmdResult<Value> {
    Ok(repo::add_field(&app_id, field)?)
}

/// Replace an app's definition (the app builder). UI-only (not on the
/// MCP/HTTP surface).
#[tauri::command]
pub fn update_app(app_id: String, definition: Value) -> CmdResult<Value> {
    Ok(repo::update_app(&app_id, definition)?)
}

/// Delete an app and all its records. UI-only (not on the MCP/HTTP surface).
#[tauri::command]
pub fn delete_app(app_id: String) -> CmdResult<Value> {
    Ok(repo::delete_app(&app_id)?)
}

#[tauri::command]
pub fn list_records(app_id: String, view_id: Option<String>) -> CmdResult<Vec<Value>> {
    Ok(repo::list_records(&app_id, view_id.as_deref())?)
}

#[tauri::command]
pub fn create_record(app_id: String, data: Value) -> CmdResult<Value> {
    Ok(repo::create_record(&app_id, data)?)
}

#[tauri::command]
pub fn update_record(app_id: String, id: String, data: Value) -> CmdResult<Value> {
    Ok(repo::update_record(&app_id, &id, data)?)
}

#[tauri::command]
pub fn delete_record(app_id: String, id: String) -> CmdResult<Value> {
    Ok(repo::delete_record(&app_id, &id)?)
}

/// Per-app counts of records due today (reminded date fields) for the sidebar.
#[tauri::command]
pub fn due_counts() -> CmdResult<Vec<crate::reminders::DueApp>> {
    let conn = crate::db::open()?;
    Ok(crate::reminders::due_today(&conn)?)
}

/// Copy a picked image file into the app's images dir; returns `nook-img://<name>`.
#[tauri::command]
pub fn import_image(src_path: String) -> CmdResult<String> {
    Ok(crate::images::import(&src_path)?)
}

/// Absolute path of the images dir, so the renderer can build asset URLs.
#[tauri::command]
pub fn get_images_dir() -> CmdResult<String> {
    Ok(crate::images::images_dir()?.display().to_string())
}

/// Copy a picked file into the app's files dir; returns the `{ref,name,size}` a
/// `file` field stores. UI-only: the MCP server has no filesystem access, so
/// Claude can *define* `file` fields but can never attach to them.
#[tauri::command]
pub fn import_file(src_path: String) -> CmdResult<crate::files::FileRef> {
    Ok(crate::files::import(&src_path)?)
}

/// Absolute path of the files dir (thumbnails live in its `.thumbs/`), so the
/// renderer can build asset URLs.
#[tauri::command]
pub fn get_files_dir() -> CmdResult<String> {
    Ok(crate::files::files_dir()?.display().to_string())
}

/// Hand the app-bundled `.mcpb` to Claude Desktop so it shows its Install/Update
/// dialog. The bundle ships as a Tauri resource, so the user's machine needs no
/// Node/pnpm — see `mcp.rs`.
#[tauri::command]
pub fn install_mcp(app: tauri::AppHandle) -> CmdResult<crate::mcp::InstallResult> {
    Ok(crate::mcp::install(&app)?)
}

// ── P2P sharing (UI-only — deliberately NOT on the MCP/HTTP surface) ────────

use crate::sync;

/// Relation dependencies (recursive) + attachment warning for the share
/// confirmation dialog.
#[tauri::command]
pub fn share_preview(app_id: String) -> CmdResult<Value> {
    let conn = crate::db::open()?;
    let mut related: Vec<Value> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    seen.insert(app_id.clone());
    let mut queue = vec![app_id.clone()];
    let mut has_attachments = false;

    while let Some(id) = queue.pop() {
        let Ok(raw) = conn.query_row(
            "SELECT definition FROM apps WHERE id = ?1",
            [&id],
            |r| r.get::<_, String>(0),
        ) else {
            continue;
        };
        let Ok(def) = serde_json::from_str::<crate::models::AppDefinition>(&raw) else {
            continue;
        };
        if id == app_id {
            has_attachments = def.fields.iter().any(|f| {
                matches!(
                    f.field_type,
                    crate::models::FieldType::File | crate::models::FieldType::Image
                )
            });
        }
        for f in &def.fields {
            if let (crate::models::FieldType::Relation, Some(target)) = (&f.field_type, &f.app) {
                if seen.insert(target.clone()) {
                    // Offer only apps that exist and aren't already shared.
                    if let Ok((name, icon)) = conn.query_row(
                        "SELECT name, icon FROM apps WHERE id = ?1",
                        [target],
                        |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?)),
                    ) {
                        if !sync::store::is_shared(&conn, target)? {
                            related.push(
                                serde_json::json!({ "id": target, "name": name, "icon": icon }),
                            );
                        }
                        queue.push(target.clone());
                    }
                }
            }
        }
    }
    Ok(serde_json::json!({ "relatedApps": related, "hasAttachments": has_attachments }))
}

#[tauri::command]
pub fn share_app(app_ids: Vec<String>) -> CmdResult<String> {
    Ok(sync::net::request(|reply| sync::net::Cmd::Share { app_ids, reply })?)
}

#[tauri::command]
pub fn create_invite(app_id: String) -> CmdResult<String> {
    Ok(sync::net::request(|reply| sync::net::Cmd::Invite { app_id, reply })?)
}

#[tauri::command]
pub fn join_share(ticket: String) -> CmdResult<Vec<String>> {
    Ok(sync::net::request(|reply| sync::net::Cmd::Join { ticket, reply })?)
}

#[tauri::command]
pub fn leave_share(app_id: String) -> CmdResult<()> {
    Ok(sync::net::request(|reply| sync::net::Cmd::Leave { app_id, reply })?)
}

#[tauri::command]
pub fn remove_member(app_id: String, device_id: String) -> CmdResult<()> {
    Ok(sync::net::request(|reply| sync::net::Cmd::RemoveMember {
        app_id,
        device_id,
        reply,
    })?)
}

/// Status of every shared app: members (with last-sync times), connectivity,
/// and how many local changes haven't reached everyone yet.
#[tauri::command]
pub fn share_status() -> CmdResult<Vec<Value>> {
    let conn = crate::db::open()?;
    let me = sync::store::device_id(&conn)?;
    let mut out = Vec::new();
    for app_id in sync::store::shared_apps(&conn)? {
        let (_, epoch) = sync::store::share_secret(&conn, &app_id)?;
        let members: Vec<Value> = sync::store::members(&conn, &app_id)?
            .into_iter()
            .filter(|m| !m.removed)
            .map(|m| {
                use rusqlite::OptionalExtension;
                let last_sync: Option<String> = conn
                    .query_row(
                        "SELECT last_sync_at FROM sync_cursors WHERE app_id=?1 AND peer_device=?2",
                        rusqlite::params![app_id, m.device_id],
                        |r| r.get(0),
                    )
                    .optional()
                    .ok()
                    .flatten()
                    .flatten();
                serde_json::json!({
                    "deviceId": m.device_id,
                    "name": m.name,
                    "isSelf": m.device_id == me,
                    "lastSyncAt": last_sync,
                    "connected": false, // per-member connectivity is not tracked; the app-level count is
                })
            })
            .collect();
        out.push(serde_json::json!({
            "appId": app_id,
            "epoch": epoch,
            "connectedPeers": sync::net::connected_peers(&app_id),
            "pendingOut": sync::store::pending_out(&conn, &app_id, &me)?,
            "members": members,
        }));
    }
    Ok(out)
}

#[tauri::command]
pub fn get_device_name() -> CmdResult<Option<String>> {
    let conn = crate::db::open()?;
    Ok(sync::net::device_name(&conn)?)
}

#[tauri::command]
pub fn set_device_name(name: String) -> CmdResult<()> {
    let conn = crate::db::open()?;
    conn.execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES ('device_name', ?1)",
        [&name],
    )?;
    Ok(())
}
