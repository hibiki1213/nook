import { useMemo, useState } from "react";
import { Button } from "@emobi/ui";
import { formatMoney } from "../lib/format";
import { aggregate, weekStart } from "../lib/metric";
import type { AppDefinition, MetricFn, RecordRow, View } from "../types";

// Cell geometry (px — the grid scrolls horizontally rather than scaling).
const CELL = 12;
const GAP = 3;
const STEP = CELL + GAP;
const PAD_LEFT = 28; // weekday labels
const PAD_TOP = 18; // month labels

// 5-step intensity from the accent scale (empty → strongest).
const FILL = [
  "var(--bg-tertiary)",
  "var(--color-accent-4)",
  "var(--color-accent-6)",
  "var(--color-accent-8)",
  "var(--color-accent-10)",
];
const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];
const MONTHS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"];

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

/** GitHub-contribution-style year grid — intensity per day. Great for habits. */
export function HeatmapView({
  app,
  view,
  records,
}: {
  app: AppDefinition;
  view: View;
  records: RecordRow[];
}) {
  const dateField =
    app.fields.find((f) => f.id === view.dateField) ??
    app.fields.find((f) => f.type === "date");
  const metricField = app.fields.find((f) => f.id === view.metric?.field);
  const fn: MetricFn = view.metric?.fn ?? (metricField ? "sum" : "count");

  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());

  // Per-day aggregated value from records whose date falls in `year`.
  const byDay = useMemo(() => {
    const buckets = new Map<string, number[]>();
    if (!dateField) return new Map<string, number>();
    for (const r of records) {
      const raw = r.data[dateField.id];
      if (typeof raw !== "string" || !raw.startsWith(`${year}-`)) continue;
      const k = raw.slice(0, 10);
      const arr = buckets.get(k) ?? buckets.set(k, []).get(k)!;
      if (fn !== "count" && metricField) {
        const n = Number(r.data[metricField.id]);
        if (Number.isFinite(n)) arr.push(n);
      } else {
        arr.push(0);
      }
    }
    const out = new Map<string, number>();
    for (const [k, arr] of buckets) out.set(k, aggregate(arr, fn));
    return out;
  }, [records, dateField, metricField, fn, year]);

  // Build week columns from the Sunday on/before Jan 1 to cover the whole year.
  const { weeks, monthLabels, maxValue, total } = useMemo(() => {
    const first = weekStart(new Date(year, 0, 1));
    const end = new Date(year, 11, 31);
    const weeks: { date: Date; inYear: boolean; value: number }[][] = [];
    const monthLabels: { col: number; text: string }[] = [];
    let cursor = new Date(first);
    let col = 0;
    let lastMonth = -1;
    let maxValue = 0;
    let total = 0;

    while (cursor <= end || weeks.length === 0 || col === weeks.length) {
      const week: { date: Date; inYear: boolean; value: number }[] = [];
      for (let d = 0; d < 7; d++) {
        const date = new Date(cursor);
        const inYear = date.getFullYear() === year;
        const value = inYear ? byDay.get(dayKey(date)) ?? 0 : 0;
        if (inYear && value > 0) {
          maxValue = Math.max(maxValue, value);
          total += value;
        }
        week.push({ date, inYear, value });
        cursor.setDate(cursor.getDate() + 1);
      }
      // Month label when the week's first in-year day starts a new month.
      const marker = week.find((c) => c.inYear);
      if (marker && marker.date.getMonth() !== lastMonth) {
        lastMonth = marker.date.getMonth();
        monthLabels.push({ col, text: MONTHS[lastMonth] });
      }
      weeks.push(week);
      col++;
      if (cursor > end) break;
    }
    return { weeks, monthLabels, maxValue, total };
  }, [byDay, year]);

  if (!dateField) {
    return (
      <div className="nk-empty-state">
        ヒートマップには dateField（日付フィールド）が必要です。
      </div>
    );
  }

  const level = (v: number) => {
    if (v <= 0 || maxValue <= 0) return 0;
    const r = v / maxValue;
    if (r > 0.75) return 4;
    if (r > 0.5) return 3;
    if (r > 0.25) return 2;
    return 1;
  };
  const fmt = (v: number) =>
    metricField?.type === "money"
      ? formatMoney(v, metricField.currency)
      : v.toLocaleString();
  const unit = metricField && fn !== "count" ? metricField.label : "件";

  const width = PAD_LEFT + weeks.length * STEP;
  const height = PAD_TOP + 7 * STEP;

  return (
    <div className="nk-heatmap">
      <div className="nk-heatmap-toolbar">
        <Button variant="ghost" onClick={() => setYear((y) => y - 1)}>
          ‹
        </Button>
        <div className="nk-heatmap-title">{year} 年</div>
        <Button variant="ghost" onClick={() => setYear((y) => y + 1)}>
          ›
        </Button>
        <Button variant="ghost" onClick={() => setYear(now.getFullYear())}>
          今年
        </Button>
        <div className="nk-heatmap-total">
          合計 {fmt(total)}
          {fn !== "count" && metricField ? "" : " 件"}
        </div>
      </div>

      <div className="nk-heatmap-scroll">
        <svg width={width} height={height} className="nk-heatmap-svg" role="img">
          {monthLabels.map((m) => (
            <text
              key={`${m.col}-${m.text}`}
              className="nk-heatmap-month"
              x={PAD_LEFT + m.col * STEP}
              y={PAD_TOP - 6}
            >
              {m.text}
            </text>
          ))}
          {[1, 3, 5].map((row) => (
            <text
              key={row}
              className="nk-heatmap-weekday"
              x={PAD_LEFT - 6}
              y={PAD_TOP + row * STEP + CELL - 2}
              textAnchor="end"
            >
              {WEEKDAYS[row]}
            </text>
          ))}
          {weeks.map((week, col) =>
            week.map((cell, row) =>
              cell.inYear ? (
                <rect
                  key={`${col}-${row}`}
                  className="nk-heatmap-cell"
                  x={PAD_LEFT + col * STEP}
                  y={PAD_TOP + row * STEP}
                  width={CELL}
                  height={CELL}
                  rx={2}
                  fill={FILL[level(cell.value)]}
                >
                  <title>
                    {dayKey(cell.date)}:{" "}
                    {cell.value > 0 ? `${fmt(cell.value)} ${unit}` : "なし"}
                  </title>
                </rect>
              ) : null,
            ),
          )}
        </svg>
      </div>

      <div className="nk-heatmap-legend">
        <span>少</span>
        {FILL.map((f, i) => (
          <span key={i} className="nk-heatmap-swatch" style={{ background: f }} />
        ))}
        <span>多</span>
      </div>
    </div>
  );
}
