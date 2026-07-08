//! Local file storage for `file` fields. Picked files are copied into
//! `<app-data>/files/` and the record stores only a small reference object
//! (`{ref, name, size}`), so the DB stays lean and `list_records` polling stays
//! cheap — the same trade `images` makes.
//!
//! Thumbnails come from macOS QuickLook (`qlmanage -t`), which renders PDFs,
//! Office documents and images alike. That is why Nook needs no PDF library:
//! the OS already has one. Generation is best-effort — a missing thumbnail just
//! falls back to a file-type icon in the UI.
//!
//! Deliberately no deletion/GC, matching `images`: removing a record leaves its
//! bytes behind (safe over clever for personal data). Attachments are far bigger
//! than thumbnails, so a vacuum command is the obvious next step.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, Context, Result};
use serde::Serialize;

/// Documents and images. Executables and scripts are refused, so an attachment
/// can never be something the OS would run on a double-click.
const ALLOWED_EXT: &[&str] = &[
    // documents
    "pdf", "txt", "md", "csv", "rtf", "json",
    // office / iWork
    "doc", "docx", "xls", "xlsx", "ppt", "pptx", "pages", "numbers", "key",
    // images
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "heic", "svg",
    // archives
    "zip",
];

pub const REF_PREFIX: &str = "nook-file://";

/// What a `file` field stores in the record's JSON.
///
/// Unlike `image` (a bare string) we keep the original filename: `2023年度_期末.pdf`
/// is the entire point of an attachment, whereas `f_1783_442.pdf` tells the user
/// nothing.
#[derive(Debug, Serialize)]
pub struct FileRef {
    #[serde(rename = "ref")]
    pub reference: String,
    pub name: String,
    pub size: u64,
}

/// `~/Library/Application Support/com.nook.app/files` — beside the DB.
pub fn files_dir() -> Result<PathBuf> {
    let home = std::env::var("HOME").context("HOME not set")?;
    let dir = PathBuf::from(home)
        .join("Library")
        .join("Application Support")
        .join("com.nook.app")
        .join("files");
    std::fs::create_dir_all(&dir).context("failed to create files dir")?;
    Ok(dir)
}

/// Thumbnails live *under* the files dir so a single asset-protocol scope
/// (`$APPDATA/files/**`) covers both the originals and their previews.
fn thumbs_dir() -> Result<PathBuf> {
    let dir = files_dir()?.join(".thumbs");
    std::fs::create_dir_all(&dir).context("failed to create thumbs dir")?;
    Ok(dir)
}

/// Copy a user-picked file into the files dir and describe it for the record.
pub fn import(src_path: &str) -> Result<FileRef> {
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
            "対応していないファイル形式です (.{ext})。対応: {}",
            ALLOWED_EXT.join(", ")
        ));
    }

    let original = src
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| format!("file.{ext}"));
    let size = std::fs::metadata(&src)
        .with_context(|| format!("ファイル情報を取得できません: {src_path}"))?
        .len();

    // Unique, sortable, ASCII-only stored name. The original may be Japanese, and
    // the thumbnail path is derived from this one.
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let stored = format!("f_{nanos}_{}.{ext}", std::process::id());

    let dest = files_dir()?.join(&stored);
    std::fs::copy(&src, &dest)
        .with_context(|| format!("ファイルのコピーに失敗しました: {src_path}"))?;

    // Best-effort: the UI falls back to a file-type icon when this produced nothing.
    let _ = make_thumbnail(&dest);

    Ok(FileRef {
        reference: format!("{REF_PREFIX}{stored}"),
        name: original,
        size,
    })
}

/// Render a preview PNG with QuickLook. `qlmanage` writes `<out>/<filename>.png`,
/// so a stored file `f_1_2.pdf` yields `.thumbs/f_1_2.pdf.png`.
fn make_thumbnail(stored: &Path) -> Result<()> {
    let out = thumbs_dir()?;
    let result = Command::new("qlmanage")
        .arg("-t")
        .args(["-s", "512"])
        .arg("-o")
        .arg(&out)
        .arg(stored)
        .output()
        .context("qlmanage を起動できませんでした")?;
    if !result.status.success() {
        return Err(anyhow!("qlmanage exited with {}", result.status));
    }
    Ok(())
}
