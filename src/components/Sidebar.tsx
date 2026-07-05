import type { AppSummary } from "../types";
import { McpPanel } from "./McpPanel";
import { ThemeToggle } from "./ThemeToggle";

export function Sidebar({
  apps,
  selected,
  onSelect,
  due = {},
}: {
  apps: AppSummary[];
  selected: string;
  onSelect: (id: string) => void;
  /** appId → count of records due today (reminded date fields). */
  due?: Record<string, number>;
}) {
  return (
    <aside className="nk-sidebar">
      {/* Draggable strip under the overlaid traffic-light buttons. */}
      <div className="nk-titlebar-drag" data-tauri-drag-region />
      <div className="nk-brand">
        <span className="nk-brand-mark">◆</span> Nook
      </div>

      <div className="nk-sidebar-label">アプリ</div>
      <nav className="nk-app-list">
        {apps.map((a) => (
          <button
            key={a.id}
            className={`nk-app-item${selected === a.id ? " is-active" : ""}`}
            onClick={() => onSelect(a.id)}
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
