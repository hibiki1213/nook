import { useEffect, useRef, useState, type ReactNode } from "react";

export interface MenuItem {
  label: string;
  onClick: () => void;
  icon?: ReactNode;
  danger?: boolean;
}

// Minimal popover menu: a trigger button + a dropdown that closes on outside
// click or Escape. Used to keep destructive actions out of the primary cluster.
export function Menu({
  trigger,
  items,
  align = "right",
  label,
}: {
  trigger: ReactNode;
  items: MenuItem[];
  align?: "left" | "right";
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="nk-menu" ref={ref}>
      <button
        type="button"
        className="nk-menu-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title={label}
        onClick={() => setOpen((o) => !o)}
      >
        {trigger}
      </button>
      {open && (
        <div className={`nk-menu-pop nk-menu-${align}`} role="menu">
          {items.map((it, i) => (
            <button
              key={i}
              type="button"
              role="menuitem"
              className={`nk-menu-item${it.danger ? " is-danger" : ""}`}
              onClick={() => {
                setOpen(false);
                it.onClick();
              }}
            >
              {it.icon && <span className="nk-menu-item-icon">{it.icon}</span>}
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
