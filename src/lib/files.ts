// Resolving `file` field values into something the UI can embed or hand to the OS.
//
// A value is a `FileRef` — or an array of them when the field is `multiple`. The
// bytes live in the app-data files dir, and `.thumbs/` holds the QuickLook preview
// generated at import time. Both are served over Tauri's asset protocol, which is
// why `$APPDATA/files/**` must be in `assetProtocol.scope`.
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import type { FileRef } from "../types";

const LOCAL_PREFIX = "nook-file://";

// The absolute files dir, fetched once at startup (App calls initFiles()). Sync
// access keeps FieldValue/FilePicker simple; until it arrives, thumbnails render
// as broken and are hidden by their onError, for a few ms at most.
let filesDir: string | null = null;

export async function initFiles(): Promise<void> {
  if (filesDir != null) return;
  filesDir = await invoke<string>("get_files_dir");
}

function storedName(ref: string): string {
  return ref.startsWith(LOCAL_PREFIX) ? ref.slice(LOCAL_PREFIX.length) : ref;
}

/** Absolute path — what `openPath` needs to hand the file to a native app. */
export function fileAbsPath(ref: string): string | null {
  return filesDir == null ? null : `${filesDir}/${storedName(ref)}`;
}

/** asset:// URL for embedding: <iframe> for PDFs, <img> for images. */
export function resolveFileSrc(ref: string): string {
  const path = fileAbsPath(ref);
  return path ? convertFileSrc(path) : "";
}

/** QuickLook thumbnail. May not exist (best-effort) — hide the <img> via onError. */
export function resolveThumbSrc(ref: string): string {
  if (filesDir == null) return "";
  return convertFileSrc(`${filesDir}/.thumbs/${storedName(ref)}.png`);
}

export function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i < 0 ? "" : name.slice(i + 1).toLowerCase();
}

const IMAGE_EXT = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "heic", "svg"];

/** WKWebView renders PDFs natively — that's what makes inline preview free. */
export const isPdf = (name: string) => extOf(name) === "pdf";
export const isImage = (name: string) => IMAGE_EXT.includes(extOf(name));
/** Everything else (Office, zip…) can only be opened in its native app. */
export const isEmbeddable = (name: string) => isPdf(name) || isImage(name);

/** 284100 → "277 KB" */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[i]}`;
}

/**
 * Normalize a stored value into a list. A `file` field holds one ref, a
 * `multiple` one holds an array — every consumer wants the array form.
 */
export function toFileRefs(value: unknown): FileRef[] {
  if (value == null || value === "") return [];
  const items = Array.isArray(value) ? value : [value];
  return items.filter(
    (v): v is FileRef =>
      typeof v === "object" &&
      v !== null &&
      typeof (v as FileRef).ref === "string",
  );
}
