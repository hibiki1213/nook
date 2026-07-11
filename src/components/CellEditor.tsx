// Bare (label-less) editor for one table cell. The form-flavored counterpart
// is FieldInput — this one is tuned for click-to-edit: autofocus, Enter
// commits, Esc cancels, focus leaving the cell commits.
import { useEffect, useRef, useState } from "react";
import { Stars, TagInput } from "./primitives";
import { RelationSelect } from "./FieldInput";
import { toTags } from "../lib/format";
import type { Field } from "../types";

/** Commit when a pointer press lands outside `ref`. Button-based editors
 *  (tags, rating) can't use blur: on macOS WebKit a <button> click doesn't
 *  move focus, so relatedTarget is null and the editor would close before the
 *  click registers. Watching document pointerdown sidesteps focus entirely. */
function useOutsideCommit(
  ref: React.RefObject<HTMLElement | null>,
  onOutside: () => void,
) {
  const cb = useRef(onOutside);
  cb.current = onOutside;
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const el = ref.current;
      if (el && !el.contains(e.target as Node)) cb.current();
    };
    // Capture + a tick's delay so the opening click doesn't self-trigger.
    const id = window.setTimeout(
      () => document.addEventListener("pointerdown", onDown, true),
      0,
    );
    return () => {
      window.clearTimeout(id);
      document.removeEventListener("pointerdown", onDown, true);
    };
  }, [ref]);
}

export function CellEditor({
  field,
  value,
  onCommit,
  onCancel,
}: {
  field: Field;
  value: unknown;
  /** Called with the coerced new value. Not called when nothing changed. */
  onCommit: (v: unknown) => void;
  onCancel: () => void;
}) {
  const str = value == null ? "" : String(value);
  const [draft, setDraft] = useState(str);
  // Once finished (committed or cancelled) ignore the trailing blur, which
  // still fires while the editor unmounts.
  const done = useRef(false);
  const finish = (fn: () => void) => {
    if (done.current) return;
    done.current = true;
    fn();
  };

  const toNumber = (s: string) => (s === "" ? null : Number(s));
  const isNumeric = field.type === "number" || field.type === "money";
  const commitDraft = () =>
    finish(() => {
      const next = isNumeric ? toNumber(draft) : draft;
      const prev = isNumeric ? (value ?? null) : str;
      if (next === prev) onCancel();
      else onCommit(next);
    });
  const cancel = () => finish(onCancel);

  // Text-ish inputs: select the current content so typing replaces it.
  const inputRef = useRef<HTMLInputElement | null>(null);
  const areaRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    inputRef.current?.select();
    areaRef.current?.select();
  }, []);

  const onKeys = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      cancel();
    } else if (
      e.key === "Enter" &&
      (field.type !== "textarea" || e.metaKey || e.ctrlKey)
    ) {
      e.preventDefault();
      commitDraft();
    }
  };

  switch (field.type) {
    case "textarea":
      return (
        <textarea
          ref={areaRef}
          className="nk-cell-input nk-cell-textarea"
          rows={3}
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeys}
          onBlur={commitDraft}
        />
      );
    case "select":
      return (
        <div className="nk-select nk-cell-select">
          <select
            autoFocus
            value={str}
            onKeyDown={onKeys}
            onChange={(e) => finish(() => onCommit(e.target.value))}
            onBlur={cancel}
          >
            <option value="" disabled hidden>
              選択…
            </option>
            {(field.options ?? []).map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        </div>
      );
    case "rating":
      return (
        <CellBlurGroup onDone={cancel} onKeys={onKeys}>
          <Stars
            value={typeof value === "number" ? value : 0}
            max={field.max ?? 5}
            onChange={(v) => finish(() => onCommit(v))}
          />
        </CellBlurGroup>
      );
    case "tags":
      return (
        <TagsCellEditor field={field} value={value} onCommit={onCommit} onCancel={onCancel} />
      );
    case "relation":
      return (
        <CellBlurGroup onDone={cancel} onKeys={onKeys}>
          <RelationSelect
            field={field}
            value={value}
            onChange={(v) => finish(() => onCommit(v))}
          />
        </CellBlurGroup>
      );
    default: {
      // text / url / number / money / date all edit as a bare <input>.
      const type =
        field.type === "date" ? "date" : isNumeric ? "number" : "text";
      return (
        <input
          ref={inputRef}
          className="nk-cell-input"
          type={type}
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeys}
          onBlur={commitDraft}
        />
      );
    }
  }
}

/** Wrapper that ends editing when a press lands outside it (for button-based
 *  editors like stars, where clicks don't move focus on macOS). */
function CellBlurGroup({
  children,
  onDone,
  onKeys,
}: {
  children: React.ReactNode;
  onDone: () => void;
  onKeys: (e: React.KeyboardEvent) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>("button, select, input")?.focus();
  }, []);
  useOutsideCommit(ref, onDone);
  return (
    <div ref={ref} className="nk-cell-group" onKeyDown={onKeys}>
      {children}
    </div>
  );
}

/** Tags accumulate across several interactions, so keep a local draft and
 *  commit the whole array when focus leaves the cell. */
function TagsCellEditor({
  field,
  value,
  onCommit,
  onCancel,
}: {
  field: Field;
  value: unknown;
  onCommit: (v: unknown) => void;
  onCancel: () => void;
}) {
  const original = toTags(value);
  const [tags, setTags] = useState<string[]>(original);
  const tagsRef = useRef(tags);
  tagsRef.current = tags;
  const done = useRef(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const finishTags = () => {
    if (done.current) return;
    done.current = true;
    const next = tagsRef.current;
    if (
      next.length === original.length &&
      next.every((t, i) => t === original[i])
    ) {
      onCancel();
    } else {
      onCommit(next);
    }
  };
  useOutsideCommit(rootRef, finishTags);
  return (
    <div
      ref={rootRef}
      className="nk-cell-group"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          done.current = true;
          onCancel();
        }
      }}
    >
      <TagInput value={tags} options={field.options} onChange={setTags} />
    </div>
  );
}
