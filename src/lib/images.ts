// Resolving `image` field values to something an <img src> can load.
//
// A value is either a normal URL (`https://…`, `data:…`) or a local reference
// `nook-img://<filename>` created by the file picker — the file itself lives in
// the app-data images dir and is served over Tauri's asset protocol.
import { convertFileSrc, invoke } from "@tauri-apps/api/core";

const LOCAL_PREFIX = "nook-img://";

// The absolute images dir, fetched once at startup (App calls initImages()).
// Sync access keeps FieldValue/GalleryView simple; until the dir arrives local
// images render as broken (hidden by their onError) for a few ms at most.
let imagesDir: string | null = null;

export async function initImages(): Promise<void> {
  if (imagesDir != null) return;
  imagesDir = await invoke<string>("get_images_dir");
}

export function isLocalImage(value: string): boolean {
  return value.startsWith(LOCAL_PREFIX);
}

/** Turn a stored image value into a loadable src (asset URL for local files). */
export function resolveImageSrc(value: string): string {
  if (!isLocalImage(value)) return value;
  if (imagesDir == null) return ""; // not initialized yet
  return convertFileSrc(`${imagesDir}/${value.slice(LOCAL_PREFIX.length)}`);
}
