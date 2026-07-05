// Thin wrappers over the Tauri commands. Tauri maps camelCase JS keys to the
// snake_case Rust parameters (appId -> app_id, viewId -> view_id).
import { invoke } from "@tauri-apps/api/core";
import type { AppDefinition, AppSummary, RecordRow } from "./types";

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
  log: string;
}

/** Repack the MCP bundle and open it for Claude Desktop's Install/Update dialog. */
export const installMcp = () => invoke<InstallMcpResult>("install_mcp");

/** Copy a picked file into the images dir → returns the `nook-img://` value. */
export const importImage = (srcPath: string) =>
  invoke<string>("import_image", { srcPath });
