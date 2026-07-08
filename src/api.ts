// Thin wrappers over the Tauri commands. Tauri maps camelCase JS keys to the
// snake_case Rust parameters (appId -> app_id, viewId -> view_id).
import { invoke } from "@tauri-apps/api/core";
import type {
  AppDefinition,
  AppSummary,
  DueApp,
  FileRef,
  RecordRow,
} from "./types";

export const listApps = () => invoke<AppSummary[]>("list_apps");

export const getApp = (appId: string) =>
  invoke<AppDefinition>("get_app", { appId });

export const deleteApp = (appId: string) =>
  invoke<{ deleted: string }>("delete_app", { appId });

export const listRecords = (appId: string, viewId?: string) =>
  invoke<RecordRow[]>("list_records", { appId, viewId: viewId ?? null });

export const createRecord = (appId: string, data: Record<string, unknown>) =>
  invoke<RecordRow>("create_record", { appId, data });

export const updateRecord = (
  appId: string,
  id: number,
  data: Record<string, unknown>,
) => invoke<RecordRow>("update_record", { appId, id, data });

export const deleteRecord = (appId: string, id: number) =>
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
