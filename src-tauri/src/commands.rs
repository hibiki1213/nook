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
pub fn update_record(app_id: String, id: i64, data: Value) -> CmdResult<Value> {
    Ok(repo::update_record(&app_id, id, data)?)
}

#[tauri::command]
pub fn delete_record(app_id: String, id: i64) -> CmdResult<Value> {
    Ok(repo::delete_record(&app_id, id)?)
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

/// Repack the MCP `.mcpb` (bumped version) and open it so Claude Desktop shows
/// its Install/Update dialog. Runs off the main thread — the pack can take a
/// while (esbuild + dxt).
#[tauri::command]
pub async fn install_mcp() -> CmdResult<crate::mcp::InstallResult> {
    match tauri::async_runtime::spawn_blocking(crate::mcp::install).await {
        Ok(inner) => Ok(inner?),
        Err(e) => Err(anyhow::anyhow!("MCP更新タスクが失敗しました: {e}").into()),
    }
}
