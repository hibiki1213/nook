import { useRef, useState } from "react";
import { FieldValue } from "./FieldValue";
import { Chip } from "./primitives";
import type { AppDefinition, Field, RecordRow, View } from "../types";

/** An in-flight card drag. Pointer-based, NOT HTML5 drag & drop: the Tauri
 *  webview's native drag handler (needed for file drops) swallows HTML5 drag
 *  events, so `drop` never fires there (see ImagePicker for the same story). */
interface Drag {
  record: RecordRow;
  /** pointer position */
  x: number;
  y: number;
  /** grab offset inside the card + its width, so the ghost sits under the hand */
  dx: number;
  dy: number;
  w: number;
  /** column option currently hovered */
  over: string | null;
}

const DRAG_THRESHOLD = 5;

/** Kanban-style view: one column per option of the groupBy select field.
 *  Cards can be dragged between columns to change the groupBy value. */
export function BoardView({
  app,
  view,
  records,
  onOpen,
  onMove,
}: {
  app: AppDefinition;
  view: View;
  records: RecordRow[];
  onOpen: (r: RecordRow) => void;
  onMove?: (r: RecordRow, fieldId: string, value: string) => void;
}) {
  const [drag, setDragState] = useState<Drag | null>(null);
  // Mirror of `drag` readable synchronously: a pointerup can arrive before
  // React commits the state from the last pointermove.
  const dragRef = useRef<Drag | null>(null);
  const setDrag = (d: Drag | null) => {
    dragRef.current = d;
    setDragState(d);
  };
  // Set on pointerdown; becomes a drag only after the threshold is crossed.
  const press = useRef<{
    record: RecordRow;
    x: number;
    y: number;
    dx: number;
    dy: number;
    w: number;
  } | null>(null);

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

  // Geometric hit test — works while the pointer is captured by the card,
  // and the ghost is pointer-events:none so it never occludes the result.
  const columnAt = (x: number, y: number) =>
    document
      .elementFromPoint(x, y)
      ?.closest<HTMLElement>("[data-board-col]")
      ?.dataset.boardCol ?? null;

  const onPointerDown = (r: RecordRow) => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    // Prevent text selection / native image drag from hijacking the gesture.
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    press.current = {
      record: r,
      x: e.clientX,
      y: e.clientY,
      dx: e.clientX - rect.left,
      dy: e.clientY - rect.top,
      w: rect.width,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const p = press.current;
    if (!p) return;
    if (
      !dragRef.current &&
      (!onMove ||
        Math.hypot(e.clientX - p.x, e.clientY - p.y) < DRAG_THRESHOLD)
    ) {
      return;
    }
    setDrag({
      record: p.record,
      x: e.clientX,
      y: e.clientY,
      dx: p.dx,
      dy: p.dy,
      w: p.w,
      over: columnAt(e.clientX, e.clientY),
    });
  };

  const endDrag = (commit: boolean) => {
    const p = press.current;
    const d = dragRef.current;
    press.current = null;
    if (!p) return;
    if (!d) {
      // Never crossed the threshold — that's a plain click.
      if (commit) onOpen(p.record);
      return;
    }
    const from = String(p.record.data[groupField.id] ?? "");
    if (commit && d.over && d.over !== from) {
      onMove?.(p.record, groupField.id, d.over);
    }
    setDrag(null);
  };

  const cardBody = (r: RecordRow) => (
    <>
      <div className="nk-card-title">
        {titleField ? String(r.data[titleField.id] ?? "無題") : "無題"}
      </div>
      <div className="nk-card-meta">
        {cardFields.map((f: Field) => (
          <FieldValue key={f.id} field={f} value={r.data[f.id]} />
        ))}
      </div>
    </>
  );

  return (
    <div className="nk-board">
      {columns.map((opt) => {
        const rows = inColumn(opt);
        return (
          <div
            className={`nk-board-col${drag?.over === opt ? " is-drop-target" : ""}`}
            key={opt}
            data-board-col={opt}
          >
            <div className="nk-board-col-head">
              <Chip value={opt} options={columns} />
              <span className="nk-count">{rows.length}</span>
            </div>
            <div className="nk-board-col-body">
              {rows.map((r) => (
                <div
                  className={`nk-card${drag?.record.id === r.id ? " is-dragging" : ""}`}
                  key={r.id}
                  onPointerDown={onPointerDown(r)}
                  onPointerMove={onPointerMove}
                  onPointerUp={() => endDrag(true)}
                  onPointerCancel={() => endDrag(false)}
                >
                  {cardBody(r)}
                </div>
              ))}
              {!rows.length && <div className="nk-card-empty">—</div>}
            </div>
          </div>
        );
      })}
      {drag && (
        <div
          className="nk-card nk-card-ghost"
          style={{
            left: drag.x - drag.dx,
            top: drag.y - drag.dy,
            width: drag.w,
          }}
        >
          {cardBody(drag.record)}
        </div>
      )}
    </div>
  );
}
