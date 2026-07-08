//! One-click "connect to Claude Desktop" from inside the app.
//!
//! The `.mcpb` extension bundle is built at **build time** (`pnpm build:mcpb`, wired
//! into `beforeBuildCommand`) and shipped inside the app as a Tauri resource. At
//! runtime we only copy it out of the read-only app bundle and hand it to Claude
//! Desktop, which shows its own Install/Update dialog.
//!
//! This is what makes the app self-contained: the user's machine needs no repo,
//! no Node and no pnpm — unlike the old repack-on-click approach.

use std::path::PathBuf;
use std::process::Command;

use anyhow::{anyhow, Context, Result};
use serde::Serialize;
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Manager};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallResult {
    pub ok: bool,
    /// Version of the bundled extension — always the app's own version, because
    /// `manifest.json` is kept in lockstep with the app.
    pub version: String,
    pub mcpb_path: String,
}

/// Copy the bundled `nook.mcpb` to a stable path, then open it for Claude Desktop.
pub fn install(app: &AppHandle) -> Result<InstallResult> {
    let src: PathBuf = app
        .path()
        .resolve("nook.mcpb", BaseDirectory::Resource)
        .context("同梱の nook.mcpb を解決できませんでした")?;

    if !src.exists() {
        return Err(anyhow!(
            "同梱の nook.mcpb が見つかりません: {}\n\
             （開発中の場合は `pnpm build:mcpb` を一度実行してください）",
            src.display()
        ));
    }

    // Copy out of the read-only .app bundle so Claude Desktop opens a stable path.
    let dst = std::env::temp_dir().join("nook.mcpb");
    std::fs::copy(&src, &dst)
        .with_context(|| format!("nook.mcpb をコピーできませんでした: {}", dst.display()))?;

    // `.mcpb`'s default handler is Claude Desktop → its Install/Update dialog.
    let status = Command::new("open")
        .arg(&dst)
        .status()
        .context(".mcpb を開けませんでした。Claude Desktop はインストール済みですか？")?;

    if !status.success() {
        return Err(anyhow!(
            "`open` が失敗しました。Claude Desktop がインストールされているか確認してください。"
        ));
    }

    Ok(InstallResult {
        ok: true,
        version: app.package_info().version.to_string(),
        mcpb_path: dst.display().to_string(),
    })
}
