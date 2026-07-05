// Small primitives the design system doesn't ship, built from the same tokens
// so they sit consistently next to @emobi/ui components.
import React, { useEffect, useState } from "react";
import { chipColor } from "../lib/palette";

// ── Select ──────────────────────────────────────────────────────────────────
export function Select({
  value,
  onChange,
  options,
  placeholder = "選択…",
  id,
}: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
  placeholder?: string;
  id?: string;
}) {
  return (
    <div className="nk-select">
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="" disabled hidden>
          {placeholder}
        </option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
      <svg
        className="nk-select-chevron"
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <polyline points="6 9 12 15 18 9" />
      </svg>
    </div>
  );
}

// ── Textarea ────────────────────────────────────────────────────────────────
export function Textarea({
  label,
  value,
  onChange,
  rows = 3,
  id,
}: {
  label?: string;
  value: string;
  onChange: (v: string) => void;
  rows?: number;
  id?: string;
}) {
  return (
    <div className="nk-field">
      {label && (
        <label htmlFor={id} className="nk-label">
          {label}
        </label>
      )}
      <textarea
        id={id}
        className="nk-textarea"
        rows={rows}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

// ── Colored chip for select values ──────────────────────────────────────────
export function Chip({
  value,
  options,
}: {
  value: string;
  options?: string[];
}) {
  const c = chipColor(value, options);
  return (
    <span
      className="nk-chip"
      style={{ background: c.bg, color: c.fg }}
    >
      {value}
    </span>
  );
}

// ── Star rating (interactive) ─────────────────────────────────────────────────
export function Stars({
  value,
  onChange,
  max = 5,
}: {
  value: number;
  onChange: (v: number | null) => void;
  max?: number;
}) {
  return (
    <div className="nk-stars nk-stars-input" role="radiogroup">
      {Array.from({ length: max }, (_, i) => i + 1).map((n) => (
        <button
          type="button"
          key={n}
          className={`nk-star${n <= value ? " is-on" : ""}`}
          aria-label={`${n}`}
          // Click the current value again to clear it.
          onClick={() => onChange(n === value ? null : n)}
        >
          ★
        </button>
      ))}
    </div>
  );
}

// ── Tag input: toggle from `options`, or free-form (add on Enter/comma) ────────
export function TagInput({
  value,
  onChange,
  options,
}: {
  value: string[];
  onChange: (v: string[]) => void;
  options?: string[];
}) {
  const [draft, setDraft] = useState("");
  const has = (t: string) => value.includes(t);
  const toggle = (t: string) =>
    onChange(has(t) ? value.filter((x) => x !== t) : [...value, t]);
  const remove = (t: string) => onChange(value.filter((x) => x !== t));
  const commit = () => {
    const t = draft.trim();
    if (t && !has(t)) onChange([...value, t]);
    setDraft("");
  };

  if (options && options.length > 0) {
    return (
      <div className="nk-tag-toggles">
        {options.map((o) => (
          <button
            type="button"
            key={o}
            className={`nk-tag-toggle${has(o) ? " is-on" : ""}`}
            onClick={() => toggle(o)}
          >
            {o}
          </button>
        ))}
      </div>
    );
  }

  return (
    <div className="nk-taginput">
      {value.length > 0 && (
        <div className="nk-tag-chips">
          {value.map((t) => (
            <span className="nk-tag-chip" key={t}>
              {t}
              <button type="button" className="nk-tag-x" onClick={() => remove(t)}>
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <input
        className="nk-taginput-field"
        value={draft}
        placeholder="タグを入力して Enter…"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            commit();
          } else if (e.key === "Backspace" && draft === "" && value.length) {
            remove(value[value.length - 1]);
          }
        }}
        onBlur={commit}
      />
    </div>
  );
}

// ── Modal ───────────────────────────────────────────────────────────────────
export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="nk-modal-backdrop" onClick={onClose}>
      <div
        className="nk-modal"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="nk-modal-head">{title}</div>
        <div className="nk-modal-body">{children}</div>
        {footer && <div className="nk-modal-foot">{footer}</div>}
      </div>
    </div>
  );
}
