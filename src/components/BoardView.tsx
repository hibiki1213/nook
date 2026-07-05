import { FieldValue } from "./FieldValue";
import { Chip } from "./primitives";
import type { AppDefinition, RecordRow, View } from "../types";

/** Kanban-style view: one column per option of the groupBy select field. */
export function BoardView({
  app,
  view,
  records,
  onOpen,
}: {
  app: AppDefinition;
  view: View;
  records: RecordRow[];
  onOpen: (r: RecordRow) => void;
}) {
  const groupField = app.fields.find((f) => f.id === view.groupBy);
  if (!groupField || groupField.type !== "select") {
    return (
      <div className="nk-empty-state">
        ボード表示には、select フィールドを指す groupBy が必要です。
      </div>
    );
  }

  const columns = groupField.options ?? [];
  const titleField = app.fields.find((f) => f.type === "text") ?? app.fields[0];
  // Secondary fields shown on each card (skip title + the grouping field).
  const cardFields = app.fields
    .filter((f) => f.id !== titleField?.id && f.id !== groupField.id)
    .slice(0, 2);

  const inColumn = (opt: string) =>
    records.filter((r) => String(r.data[groupField.id] ?? "") === opt);

  return (
    <div className="nk-board">
      {columns.map((opt) => {
        const rows = inColumn(opt);
        return (
          <div className="nk-board-col" key={opt}>
            <div className="nk-board-col-head">
              <Chip value={opt} options={columns} />
              <span className="nk-count">{rows.length}</span>
            </div>
            <div className="nk-board-col-body">
              {rows.map((r) => (
                <div
                  className="nk-card"
                  key={r.id}
                  onClick={() => onOpen(r)}
                >
                  <div className="nk-card-title">
                    {titleField ? String(r.data[titleField.id] ?? "無題") : "無題"}
                  </div>
                  <div className="nk-card-meta">
                    {cardFields.map((f) => (
                      <FieldValue key={f.id} field={f} value={r.data[f.id]} />
                    ))}
                  </div>
                </div>
              ))}
              {!rows.length && <div className="nk-card-empty">—</div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
