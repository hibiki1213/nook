// A page view stacks other views via `View.blocks: string[]`. Each entry
// references a view that may live in ANOTHER app. Encoding (both ids match
// ^[a-z][a-z0-9_]*$, so a single ":" is an unambiguous separator):
//
//   "viewId"          → a view in the page's own app  (back-compatible)
//   "appId:viewId"    → a view in another app
//
// Keeping `blocks` a plain string[] means the stored model, the Rust type
// (Option<Vec<String>>) and the MCP schema all stay unchanged.

export interface BlockRef {
  /** The app the referenced view belongs to (the page's own app for local refs). */
  appId: string;
  viewId: string;
  /** True when the view lives in a different app than the page. */
  foreign: boolean;
}

/** Decode one `blocks[]` entry against the page's own app id. */
export function parseBlock(ref: string, localAppId: string): BlockRef {
  const i = ref.indexOf(":");
  if (i === -1) return { appId: localAppId, viewId: ref, foreign: false };
  return { appId: ref.slice(0, i), viewId: ref.slice(i + 1), foreign: true };
}

/** Encode a (appId, viewId) pair, collapsing to the bare view id when the
 *  view is in the page's own app. */
export function makeBlock(
  appId: string,
  viewId: string,
  localAppId: string,
): string {
  return appId === localAppId ? viewId : `${appId}:${viewId}`;
}
