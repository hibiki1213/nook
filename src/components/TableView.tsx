import { Checkbox } from "@emobi/ui";
import { FieldValue } from "./FieldValue";
import type { AppDefinition, Field, RecordRow, View } from "../types";

/** Generic table: columns come from the view (or all fields), rows from records. */
export function TableView({
  app,
  view,
  records,
  onOpen,
  onToggle,
}: {
  app: AppDefinition;
  view: View;
  records: RecordRow[];
  onOpen: (r: RecordRow) => void;
  onToggle: (r: RecordRow, fieldId: string, checked: boolean) => void;
}) {
  const ids =
    view.columns && view.columns.length ? view.columns : app.fields.map((f) => f.id);
  const cols = ids
    .map((id) => app.fields.find((f) => f.id === id))
    .filter(Boolean) as Field[];

  if (!records.length) {
    return (
      <div className="nk-empty-state">
        まだレコードがありません。「＋ 新規」から追加するか、Claude に頼んでみてください。
      </div>
    );
  }

  return (
    <div className="nk-table-wrap">
      <table className="nk-table">
        <thead>
          <tr>
            {cols.map((f) => (
              <th key={f.id}>{f.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {records.map((r) => (
            <tr key={r.id} onClick={() => onOpen(r)}>
              {cols.map((f) => (
                <td key={f.id}>
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
