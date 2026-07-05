import { useMemo, useState } from "react";
import { Button } from "@emobi/ui";
import type { AppDefinition, RecordRow, View } from "../types";

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

/** Parse a stored date value (YYYY-MM-DD…) into a local Y/M/D key, or null. */
function dateKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

function ymd(y: number, m: number, d: number): string {
  return `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Month grid placing records on a date field — good for habits, journals, plans. */
export function CalendarView({
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
  const dateField =
    app.fields.find((f) => f.id === view.dateField) ??
    app.fields.find((f) => f.type === "date");
  const titleField =
    app.fields.find((f) => f.type === "text") ?? app.fields[0];

  const now = new Date();
  const [cursor, setCursor] = useState({
    year: now.getFullYear(),
    month: now.getMonth(), // 0-based
  });

  // Bucket records by their date key once per records/field change.
  const byDate = useMemo(() => {
    const map = new Map<string, RecordRow[]>();
    if (!dateField) return map;
    for (const r of records) {
      const k = dateKey(r.data[dateField.id]);
      if (!k) continue;
      (map.get(k) ?? map.set(k, []).get(k)!).push(r);
    }
    return map;
  }, [records, dateField]);

  if (!dateField) {
    return (
      <div className="nk-empty-state">
        カレンダー表示には date フィールドを指す dateField が必要です。
      </div>
    );
  }

  const first = new Date(cursor.year, cursor.month, 1);
  const startPad = first.getDay(); // leading blanks (0=Sun)
  const daysInMonth = new Date(cursor.year, cursor.month + 1, 0).getDate();
  const todayKey = ymd(now.getFullYear(), now.getMonth(), now.getDate());

  // Build a fixed 6-row grid (42 cells) for a stable layout.
  const cells: (number | null)[] = [];
  for (let i = 0; i < startPad; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);

  const step = (delta: number) => {
    const m = cursor.month + delta;
    setCursor({
      year: cursor.year + Math.floor(m / 12),
      month: ((m % 12) + 12) % 12,
    });
  };

  return (
    <div className="nk-calendar">
      <div className="nk-cal-toolbar">
        <Button variant="ghost" onClick={() => step(-1)}>
          ‹
        </Button>
        <div className="nk-cal-title">
          {cursor.year}年 {cursor.month + 1}月
        </div>
        <Button variant="ghost" onClick={() => step(1)}>
          ›
        </Button>
        <div style={{ flex: 1 }} />
        <Button
          variant="ghost"
          onClick={() =>
            setCursor({ year: now.getFullYear(), month: now.getMonth() })
          }
        >
          今日
        </Button>
      </div>

      <div className="nk-cal-grid nk-cal-head">
        {WEEKDAYS.map((w, i) => (
          <div
            key={w}
            className={`nk-cal-weekday${i === 0 ? " is-sun" : ""}${
              i === 6 ? " is-sat" : ""
            }`}
          >
            {w}
          </div>
        ))}
      </div>

      <div className="nk-cal-grid">
        {cells.map((d, i) => {
          if (d == null) return <div key={i} className="nk-cal-cell is-blank" />;
          const key = ymd(cursor.year, cursor.month, d);
          const rows = byDate.get(key) ?? [];
          const dow = i % 7;
          return (
            <div
              key={i}
              className={`nk-cal-cell${key === todayKey ? " is-today" : ""}`}
            >
              <div
                className={`nk-cal-daynum${dow === 0 ? " is-sun" : ""}${
                  dow === 6 ? " is-sat" : ""
                }`}
              >
                {d}
              </div>
              <div className="nk-cal-events">
                {rows.slice(0, 4).map((r) => (
                  <button
                    key={r.id}
                    className="nk-cal-event"
                    title={
                      titleField ? String(r.data[titleField.id] ?? "") : ""
                    }
                    onClick={() => onOpen(r)}
                  >
                    {titleField
                      ? String(r.data[titleField.id] ?? "無題")
                      : "無題"}
                  </button>
                ))}
                {rows.length > 4 && (
                  <div className="nk-cal-more">+{rows.length - 4}</div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
