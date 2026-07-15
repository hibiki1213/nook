import type { AppSummary } from "../types";
import { GearIcon, PlusIcon, SidebarIcon } from "./icons";
import { McpPanel } from "./McpPanel";
import { ThemeToggle } from "./ThemeToggle";
import { UpdateBanner } from "./UpdateBanner";

export function Sidebar({
  apps,
  selected,
  onSelect,
  due = {},
  shared = {},
  collapsed = false,
  onToggle,
  onOpenSettings,
  onNewApp,
}: {
  apps: AppSummary[];
  selected: string;
  onSelect: (id: string) => void;
  /** appId → count of records due today (reminded date fields). */
  due?: Record<string, number>;
  /** appId → connected peer count; presence of the key = the app is shared. */
  shared?: Record<string, number>;
  collapsed?: boolean;
  onToggle?: () => void;
  onOpenSettings?: () => void;
  onNewApp?: () => void;
}) {
  return (
    <aside className={`nk-sidebar${collapsed ? " is-collapsed" : ""}`}>
      {/* The brand row doubles as the titlebar: the toggle sits clear of the
          overlaid traffic lights, and the row is the window drag handle. */}
      <div className="nk-brand" data-tauri-drag-region>
        <button
          type="button"
          className="nk-sidebar-toggle"
          onClick={onToggle}
          title={collapsed ? "サイドバーを開く (⌘B)" : "サイドバーを畳む (⌘B)"}
          aria-label={collapsed ? "サイドバーを開く" : "サイドバーを畳む"}
        >
          <SidebarIcon size={16} />
        </button>
      </div>

      <div className="nk-sidebar-label">アプリ</div>
      <nav className="nk-app-list">
        {apps.map((a) => (
          <button
            key={a.id}
            className={`nk-app-item${selected === a.id ? " is-active" : ""}`}
            onClick={() => onSelect(a.id)}
            title={collapsed ? a.name : undefined}
          >
            <span className="nk-app-icon">{a.icon ?? "🗂"}</span>
            <span className="nk-app-name">{a.name}</span>
            {a.id in shared && (
              <span
                className={`nk-app-shared${(shared[a.id] ?? 0) > 0 ? " is-on" : ""}`}
                title={
                  (shared[a.id] ?? 0) > 0
                    ? `共有中 — ${shared[a.id]} 台と接続`
                    : "共有中(接続なし)"
                }
              />
            )}
            {(due[a.id] ?? 0) > 0 && (
              <span className="nk-app-due" title="今日が期限のレコード">
                {due[a.id]}
              </span>
            )}
          </button>
        ))}
        {!apps.length && <div className="nk-hint">まだアプリがありません</div>}
        <button
          type="button"
          className="nk-app-item nk-app-new"
          onClick={onNewApp}
          title={collapsed ? "新規アプリ" : undefined}
        >
          <span className="nk-app-icon">
            <PlusIcon size={14} />
          </span>
          <span className="nk-app-name">新規アプリ</span>
        </button>
      </nav>

      <div className="nk-sidebar-foot">
        <UpdateBanner />
        <div className="nk-hint">
          新しいアプリは <b>Claude Desktop</b> に頼んで作れます。
          <br />
          例：「読書記録アプリを作って」
        </div>
        <McpPanel />
        <div className="nk-foot-row">
          <ThemeToggle />
          <button
            type="button"
            className="nk-settings-btn"
            title="設定"
            aria-label="設定"
            onClick={onOpenSettings}
          >
            <GearIcon size={14} />
          </button>
        </div>
      </div>
    </aside>
  );
}
