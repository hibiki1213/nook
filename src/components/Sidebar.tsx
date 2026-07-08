import type { AppSummary } from "../types";
import { SidebarIcon } from "./icons";
import { McpPanel } from "./McpPanel";
import { ThemeToggle } from "./ThemeToggle";
import { UpdateBanner } from "./UpdateBanner";

export function Sidebar({
  apps,
  selected,
  onSelect,
  due = {},
  collapsed = false,
  onToggle,
}: {
  apps: AppSummary[];
  selected: string;
  onSelect: (id: string) => void;
  /** appId → count of records due today (reminded date fields). */
  due?: Record<string, number>;
  collapsed?: boolean;
  onToggle?: () => void;
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
            {(due[a.id] ?? 0) > 0 && (
              <span className="nk-app-due" title="今日が期限のレコード">
                {due[a.id]}
              </span>
            )}
          </button>
        ))}
        {!apps.length && <div className="nk-hint">まだアプリがありません</div>}
      </nav>

      <div className="nk-sidebar-foot">
        <UpdateBanner />
        <div className="nk-hint">
          新しいアプリは <b>Claude Desktop</b> に頼んで作れます。
          <br />
          例：「読書記録アプリを作って」
        </div>
        <McpPanel />
        <ThemeToggle />
      </div>
    </aside>
  );
}
