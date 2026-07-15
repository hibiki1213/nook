// Thin wrappers over the Tauri commands. Tauri maps camelCase JS keys to the
// snake_case Rust parameters (appId -> app_id, viewId -> view_id).
import { invoke } from "@tauri-apps/api/core";
import type {
  AppDefinition,
  AppSummary,
  DueApp,
  FileRef,
  RecordRow,
  SharePreview,
  ShareStatus,
} from "./types";

export const listApps = () => invoke<AppSummary[]>("list_apps");

export const getApp = (appId: string) =>
  invoke<AppDefinition>("get_app", { appId });

/** Create an app from a full definition (the manual "新規アプリ" flow). */
export const createApp = (definition: AppDefinition) =>
  invoke<AppSummary>("create_app", { definition });

/** Replace an app's full definition — the app builder's save. Returns the
    definition as the backend normalized it. */
export const updateApp = (appId: string, definition: AppDefinition) =>
  invoke<AppDefinition>("update_app", { appId, definition });

export const deleteApp = (appId: string) =>
  invoke<{ deleted: string }>("delete_app", { appId });

export const listRecords = (appId: string, viewId?: string) =>
  invoke<RecordRow[]>("list_records", { appId, viewId: viewId ?? null });

export const createRecord = (appId: string, data: Record<string, unknown>) =>
  invoke<RecordRow>("create_record", { appId, data });

export const updateRecord = (
  appId: string,
  id: string,
  data: Record<string, unknown>,
) => invoke<RecordRow>("update_record", { appId, id, data });

export const deleteRecord = (appId: string, id: string) =>
  invoke<void>("delete_record", { appId, id });

export interface InstallMcpResult {
  ok: boolean;
  version: string;
  mcpbPath: string;
}

/** Hand the app-bundled .mcpb to Claude Desktop (its Install/Update dialog). */
export const installMcp = () => invoke<InstallMcpResult>("install_mcp");

/** Copy a picked file into the images dir → returns the `nook-img://` value. */
export const importImage = (srcPath: string) =>
  invoke<string>("import_image", { srcPath });

/**
 * Copy a picked file into the files dir → returns the `FileRef` to store.
 * UI-only: the MCP server has no filesystem, so Claude can define `file` fields
 * but can never attach to them.
 */
export const importFile = (srcPath: string) =>
  invoke<FileRef>("import_file", { srcPath });

/** Per-app counts of records due today (for sidebar badges). */
export const dueCounts = () => invoke<DueApp[]>("due_counts");

// ── P2P sharing ──────────────────────────────────────────────────────────────

/** Relation dependencies + attachment warning, shown before sharing starts. */
export const sharePreview = (appId: string) =>
  invoke<SharePreview>("share_preview", { appId });

/** Start sharing the given apps together. Returns the invite ticket. */
export const shareApp = (appIds: string[]) =>
  invoke<string>("share_app", { appIds });

/** Re-issue an invite ticket for an already-shared app (current epoch). */
export const createInvite = (appId: string) =>
  invoke<string>("create_invite", { appId });

/** Join shares from a pasted ticket. Returns the joined app ids. */
export const joinShare = (ticket: string) =>
  invoke<string[]>("join_share", { ticket });

/** Leave a share (local data stays; it just stops syncing). */
export const leaveShare = (appId: string) =>
  invoke<void>("leave_share", { appId });

/** Remove a member: rotates the share secret (new epoch). */
export const removeMember = (appId: string, deviceId: string) =>
  invoke<void>("remove_member", { appId, deviceId });

/** Sync status of every shared app (members, connectivity, pending count). */
export const shareStatus = () => invoke<ShareStatus[]>("share_status");

export const getDeviceName = () => invoke<string | null>("get_device_name");
export const setDeviceName = (name: string) =>
  invoke<void>("set_device_name", { name });
