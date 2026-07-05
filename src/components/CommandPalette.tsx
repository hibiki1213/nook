import { useEffect, useMemo, useRef, useState } from "react";
import { SearchIcon } from "./icons";

export interface Command {
  id: string;
  label: string;
  hint?: string;
  icon?: React.ReactNode;
  run: () => void;
}

// ⌘K palette: fuzzy-ish filter over commands, keyboard-driven. Twenty-style
// quick access to apps, views, and actions.
export function CommandPalette({
  open,
  onClose,
  commands,
}: {
  open: boolean;
  onClose: () => void;
  commands: Command[];
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
      // focus after paint
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter(
      (c) =>
        c.label.toLowerCase().includes(q) ||
        (c.hint?.toLowerCase().includes(q) ?? false),
    );
  }, [commands, query]);

  useEffect(() => {
    setActive((a) => Math.min(a, Math.max(0, filtered.length - 1)));
  }, [filtered.length]);

  if (!open) return null;

  const run = (c?: Command) => {
    if (!c) return;
    onClose();
    c.run();
  };

  return (
    <div className="nk-cmd-backdrop" onClick={onClose}>
      <div
        className="nk-cmd"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
          else if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((a) => Math.min(a + 1, filtered.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === "Enter") {
            e.preventDefault();
            run(filtered[active]);
          }
        }}
      >
        <div className="nk-cmd-search">
          <SearchIcon size={16} />
          <input
            ref={inputRef}
            className="nk-cmd-input"
            placeholder="アプリ・ビュー・操作を検索…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="nk-cmd-list">
          {filtered.length === 0 && (
            <div className="nk-cmd-empty">該当なし</div>
          )}
          {filtered.map((c, i) => (
            <button
              key={c.id}
              type="button"
              className={`nk-cmd-item${i === active ? " is-active" : ""}`}
              onMouseEnter={() => setActive(i)}
              onClick={() => run(c)}
            >
              {c.icon && <span className="nk-cmd-item-icon">{c.icon}</span>}
              <span className="nk-cmd-item-label">{c.label}</span>
              {c.hint && <span className="nk-cmd-item-hint">{c.hint}</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
