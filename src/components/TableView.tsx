import { useEffect, useRef, useState } from "react";
import { Checkbox } from "@emobi/ui";
import { FieldValue } from "./FieldValue";
import { CellEditor } from "./CellEditor";
import { EmptyState } from "./EmptyState";
import { OpenIcon } from "./icons";
import type { AppDefinition, Field, RecordRow, View } from "../types";

/** Pickers are modal-only — clicking those cells opens the record instead. */
const inlineEditable = (t: Field["type"]) => t !== "image" && t !== "file";

/** Generic table: columns come from the view (or all fields), rows from
 *  records. Cells edit inline on click; the full record opens via the row's
 *  hover 開く button or Enter. */
export function TableView({
  app,
  view,
  records,
  onOpen,
  onToggle,
  onCreate,
  onDelete,
  onEdit,
}: {
  app: AppDefinition;
  view: View;
  records: RecordRow[];
  onOpen: (r: RecordRow) => void;
  onToggle: (r: RecordRow, fieldId: string, checked: boolean) => void;
  onCreate?: () => void;
  onDelete?: (id: string) => void;
  onEdit?: (r: RecordRow, fieldId: string, value: unknown) => void;
}) {
  const ids =
    view.columns && view.columns.length ? view.columns : app.fields.map((f) => f.id);
  const cols = ids
    .map((id) => app.fields.find((f) => f.id === id))
    .filter(Boolean) as Field[];

  // Numeric columns are right-aligned so digits line up (table-UI convention).
  const isNumeric = (t: Field["type"]) =>
    t === "number" || t === "money" || t === "rating";

  // Keyboard row selection (↑↓ move · Enter open · Delete remove). Active while
  // the table is focused; clamp when records change under us.
  const [sel, setSel] = useState(-1);
  // The one cell being edited inline, if any.
  const [editing, setEditing] = useState<{ recId: string; fieldId: string } | null>(
    null,
  );
  const wrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setSel((s) => (s >= records.length ? records.length - 1 : s));
  }, [records.length]);

  if (!records.length) {
    return <EmptyState onCreate={onCreate} />;
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    // Keystrokes belong to the cell editor while one is open.
    const tag = (e.target as HTMLElement).tagName;
    if (editing || tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((s) => Math.min(s + 1, records.length - 1) || 0);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((s) => Math.max(s - 1, 0));
    } else if (e.key === "Enter" && sel >= 0) {
      e.preventDefault();
      onOpen(records[sel]);
    } else if ((e.key === "Delete" || e.key === "Backspace") && sel >= 0 && onDelete) {
      e.preventDefault();
      onDelete(records[sel].id);
    }
  };

  const startEdit = (r: RecordRow, f: Field) => {
    if (!onEdit || !inlineEditable(f.type)) {
      onOpen(r); // pickers and read-only tables keep the old behavior
      return;
    }
    setEditing({ recId: r.id, fieldId: f.id });
  };

  return (
    <div
      className="nk-table-wrap"
      ref={wrapRef}
      tabIndex={0}
      onKeyDown={onKeyDown}
    >
      <table className="nk-table">
        <thead>
          <tr>
            {cols.map((f) => (
              <th key={f.id} className={isNumeric(f.type) ? "nk-th-num" : undefined}>
                {f.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {records.map((r, i) => (
            <tr
              key={r.id}
              className={i === sel ? "is-selected" : undefined}
              onClick={() => setSel(i)}
            >
              {cols.map((f, fi) => {
                const isEditing =
                  editing?.recId === r.id && editing.fieldId === f.id;
                return (
                  <td
                    key={f.id}
                    className={`${isNumeric(f.type) ? "nk-td-num" : ""}${
                      isEditing ? " is-editing" : ""
                    }`}
                  >
                    {f.type === "checkbox" ? (
                      <span
                        className="nk-cell-check"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <Checkbox
                          checked={!!r.data[f.id]}
                          onChange={(c) => onToggle(r, f.id, c)}
                        />
                      </span>
                    ) : isEditing ? (
                      // The editor floats in a popover over the cell; the
                      // hidden value keeps the cell (and table) from reflowing.
                      <div className="nk-cell-view">
                        <span className="nk-cell-ghost" aria-hidden>
                          <FieldValue field={f} value={r.data[f.id]} />
                        </span>
                        <div className="nk-cell-pop">
                          <CellEditor
                            field={f}
                            value={r.data[f.id]}
                            onCommit={(v) => {
                              setEditing(null);
                              onEdit?.(r, f.id, v);
                            }}
                            onCancel={() => setEditing(null)}
                          />
                        </div>
                      </div>
                    ) : (
                      <div
                        className="nk-cell-view"
                        onClick={() => startEdit(r, f)}
                      >
                        <FieldValue field={f} value={r.data[f.id]} />
                        {fi === 0 && (
                          <button
                            type="button"
                            className="nk-row-open"
                            aria-label="レコードを開く"
                            title="開く"
                            onClick={(e) => {
                              e.stopPropagation();
                              setSel(i);
                              onOpen(r);
                            }}
                          >
                            <OpenIcon size={12} />
                          </button>
                        )}
                      </div>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
