//! One-click "update the Claude Desktop extension" from inside the app.
//!
//! Repacks the MCP bundle (`pnpm pack:mcpb` — rebuilds `dist/index.mjs` and the
//! `.mcpb`) with a bumped version, then opens the `.mcpb` so Claude Desktop shows
//! its own Install/Update dialog. This is a **dev-time** convenience: it needs the
//! repo + toolchain (Node/pnpm) present, which is the case while running under
//! `pnpm tauri dev`. A packaged build wouldn't ship the `mcp-server/` sources.

use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{anyhow, Context, Result};
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallResult {
    pub ok: bool,
    /// The new `.mcpb` version that was packed (bumped each run).
    pub version: String,
    pub mcpb_path: String,
    /// Tail of the pack log (for surfacing failures in the UI).
    pub log: String,
}

/// `<repo>/mcp-server`, derived from this crate's location at build time
/// (`CARGO_MANIFEST_DIR` = `<repo>/src-tauri`).
fn mcp_server_dir() -> Result<PathBuf> {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let repo = manifest_dir
        .parent()
        .context("could not resolve repo root from CARGO_MANIFEST_DIR")?;
    Ok(repo.join("mcp-server"))
}

/// Bump the patch component of `manifest.json`'s `version` in place, touching
/// only the version value so the rest of the file is preserved byte-for-byte.
/// Claude Desktop offers "Update" only when the packed version is newer.
fn bump_manifest_version(manifest_path: &Path) -> Result<String> {
    let text = std::fs::read_to_string(manifest_path)
        .with_context(|| format!("manifest not found: {}", manifest_path.display()))?;

    let key = "\"version\"";
    let kpos = text.find(key).context("no \"version\" key in manifest")?;
    let after = &text[kpos + key.len()..];
    let q1 = after.find('"').context("malformed version (no opening quote)")?;
    let val_start = kpos + key.len() + q1 + 1;
    let q2 = text[val_start..]
        .find('"')
        .context("malformed version (no closing quote)")?;
    let val_end = val_start + q2;

    let mut parts: Vec<u64> = text[val_start..val_end]
        .split('.')
        .map(|p| p.parse().unwrap_or(0))
        .collect();
    while parts.len() < 3 {
        parts.push(0);
    }
    let last = parts.len() - 1;
    parts[last] += 1;
    let new_version = parts
        .iter()
        .map(|p| p.to_string())
        .collect::<Vec<_>>()
        .join(".");

    let mut out = String::with_capacity(text.len());
    out.push_str(&text[..val_start]);
    out.push_str(&new_version);
    out.push_str(&text[val_end..]);
    std::fs::write(manifest_path, out).context("failed to write manifest.json")?;
    Ok(new_version)
}

/// Keep the last `n` characters (char-boundary safe) of a log for the UI.
fn tail(s: &str, n: usize) -> String {
    let chars: Vec<char> = s.chars().collect();
    if chars.len() <= n {
        return s.to_string();
    }
    format!("…{}", chars[chars.len() - n..].iter().collect::<String>())
}

pub fn install() -> Result<InstallResult> {
    let dir = mcp_server_dir()?;
    if !dir.join("package.json").exists() {
        return Err(anyhow!(
            "mcp-server が見つかりません（この機能は開発起動時のみ使えます）: {}",
            dir.display()
        ));
    }

    let version = bump_manifest_version(&dir.join("manifest.json"))?;

    // Run through a login shell so pnpm/node are on PATH even if the app wasn't
    // launched from a terminal. `cd` explicitly rather than trusting cwd.
    let script = format!("cd '{}' && pnpm pack:mcpb", dir.display());
    let output = Command::new("/bin/zsh")
        .arg("-lc")
        .arg(&script)
        .output()
        .context("pnpm の起動に失敗しました。Node と pnpm が入っているか確認してください")?;

    let mut log = String::new();
    log.push_str(&String::from_utf8_lossy(&output.stdout));
    log.push_str(&String::from_utf8_lossy(&output.stderr));

    if !output.status.success() {
        return Err(anyhow!("pack:mcpb が失敗しました:\n{}", tail(&log, 2000)));
    }

    let mcpb = dir.join("nook.mcpb");
    if !mcpb.exists() {
        return Err(anyhow!(
            "nook.mcpb が生成されませんでした:\n{}",
            tail(&log, 2000)
        ));
    }

    // Open with the default handler (Claude Desktop) → its Install/Update dialog.
    Command::new("open")
        .arg(&mcpb)
        .status()
        .context(".mcpb を開けませんでした")?;

    Ok(InstallResult {
        ok: true,
        version,
        mcpb_path: mcpb.display().to_string(),
        log: tail(&log, 2000),
    })
}
