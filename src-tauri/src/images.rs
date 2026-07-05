//! Local image storage for `image` fields. Files picked from the PC are copied
//! into `<app-data>/images/` and records store only a `nook-img://<filename>`
//! reference, so the DB stays small (no base64 blobs) and `list_records`
//! polling stays cheap. The renderer resolves the reference to an
//! asset-protocol URL via `convertFileSrc`.
//!
//! Deliberately no deletion/GC: removing a record or app leaves its files
//! behind (safe over clever for personal data). A vacuum can come later.

use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, Context, Result};

const ALLOWED_EXT: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "bmp", "heic"];

/// `~/Library/Application Support/com.nook.app/images` — same parent dir as the
/// DB (see `db::db_path`), created on demand.
pub fn images_dir() -> Result<PathBuf> {
    let home = std::env::var("HOME").context("HOME not set")?;
    let dir = PathBuf::from(home)
        .join("Library")
        .join("Application Support")
        .join("com.nook.app")
        .join("images");
    std::fs::create_dir_all(&dir).context("failed to create images dir")?;
    Ok(dir)
}

/// Copy a user-picked file into the images dir and return the value to store
/// in the record: `nook-img://<filename>`.
pub fn import(src_path: &str) -> Result<String> {
    let src = PathBuf::from(src_path);
    if !src.is_file() {
        return Err(anyhow!("ファイルが見つかりません: {src_path}"));
    }
    let ext = src
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    if !ALLOWED_EXT.contains(&ext.as_str()) {
        return Err(anyhow!(
            "対応していない画像形式です (.{ext})。対応: {}",
            ALLOWED_EXT.join(", ")
        ));
    }

    // Unique, sortable filename; nanos + pid make collisions implausible.
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let name = format!("img_{nanos}_{}.{ext}", std::process::id());

    let dest = images_dir()?.join(&name);
    std::fs::copy(&src, &dest)
        .with_context(|| format!("画像のコピーに失敗しました: {src_path}"))?;
    Ok(format!("nook-img://{name}"))
}
