import { useEffect, useRef, useState } from "react";
import { Checkbox } from "@emobi/ui";
import { FieldValue } from "./FieldValue";
import { EmptyState } from "./EmptyState";
import type { AppDefinition, Field, RecordRow, View } from "../types";

/** Generic table: columns come from the view (or all fields), rows from records. */
export function TableView({
  app,
  view,
  records,
  onOpen,
  onToggle,
  onCreate,
  onDelete,
}: {
  app: AppDefinition;
  view: View;
  records: RecordRow[];
  onOpen: (r: RecordRow) => void;
  onToggle: (r: RecordRow, fieldId: string, checked: boolean) => void;
  onCreate?: () => void;
  onDelete?: (id: number) => void;
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
  const wrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setSel((s) => (s >= records.length ? records.length - 1 : s));
  }, [records.length]);

  if (!records.length) {
    return <EmptyState onCreate={onCreate} />;
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
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
              onClick={() => {
                setSel(i);
                onOpen(r);
              }}
            >
              {cols.map((f) => (
                <td key={f.id} className={isNumeric(f.type) ? "nk-td-num" : undefined}>
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
                  ) : (
                    <FieldValue field={f} value={r.data[f.id]} />
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
