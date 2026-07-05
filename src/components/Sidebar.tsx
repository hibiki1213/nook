import type { AppSummary } from "../types";
import { McpPanel } from "./McpPanel";

export function Sidebar({
  apps,
  selected,
  onSelect,
}: {
  apps: AppSummary[];
  selected: string;
  onSelect: (id: string) => void;
}) {
  return (
    <aside className="nk-sidebar">
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
      </div>
    </aside>
  );
}
