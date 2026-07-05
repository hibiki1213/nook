import { useMemo } from "react";
import { formatMoney } from "../lib/format";
import { aggregate, bucketKey, bucketLabel, parseDate } from "../lib/metric";
import type { AppDefinition, Bucket, MetricFn, RecordRow, View } from "../types";

// Plot geometry (SVG user units; the SVG scales to its container width).
const W = 800;
const H = 320;
const M = { top: 16, right: 16, bottom: 28, left: 56 };
const PLOT_W = W - M.left - M.right;
const PLOT_H = H - M.top - M.bottom;

const FN_LABEL: Record<MetricFn, string> = {
  sum: "合計",
  avg: "平均",
  count: "件数",
  min: "最小",
  max: "最大",
};

/** A number/money aggregate over time — trend line for weight, spending, etc. */
export function ChartView({
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
  const bucket: Bucket = view.bucket ?? "day";
  const area = view.chartType === "area";

  const points = useMemo(() => {
    if (!dateField) return [];
    const buckets = new Map<string, number[]>();
    for (const r of records) {
      const d = parseDate(r.data[dateField.id]);
      if (!d) continue;
      const k = bucketKey(d, bucket);
      const arr = buckets.get(k) ?? buckets.set(k, []).get(k)!;
      if (fn !== "count" && metricField) {
        const n = Number(r.data[metricField.id]);
        if (Number.isFinite(n)) arr.push(n);
      } else {
        arr.push(0); // count: only length matters
      }
    }
    return [...buckets.keys()]
      .sort()
      .map((k) => ({ key: k, value: aggregate(buckets.get(k)!, fn) }));
  }, [records, dateField, metricField, fn, bucket]);

  if (!dateField) {
    return (
      <div className="nk-empty-state">
        チャートには dateField（日付フィールド）が必要です。
      </div>
    );
  }
  if (points.length < 2) {
    return (
      <div className="nk-empty-state">
        推移を描くにはこの期間に 2 点以上のデータが必要です。
      </div>
    );
  }

  const values = points.map((p) => p.value);
  const rawMax = Math.max(...values);
  const rawMin = Math.min(...values);
  // sum/count start at 0; avg/min/max frame the data range with a little pad.
  const zeroBased = fn === "sum" || fn === "count";
  const pad = (rawMax - rawMin) * 0.1 || Math.abs(rawMax) * 0.1 || 1;
  const yMax = zeroBased ? rawMax || 1 : rawMax + pad;
  const yMin = zeroBased ? 0 : rawMin - pad;
  const span = yMax - yMin || 1;

  const x = (i: number) =>
    M.left + (points.length === 1 ? PLOT_W / 2 : (i / (points.length - 1)) * PLOT_W);
  const y = (v: number) => M.top + PLOT_H - ((v - yMin) / span) * PLOT_H;

  const fmt = (v: number) =>
    metricField?.type === "money"
      ? formatMoney(v, metricField.currency)
      : (Math.round(v * 10) / 10).toLocaleString();

  const line = points.map((p, i) => `${i ? "L" : "M"}${x(i)},${y(p.value)}`).join(" ");
  const baseline = y(yMin);
  const areaPath = `${line} L${x(points.length - 1)},${baseline} L${x(0)},${baseline} Z`;

  // 4 horizontal gridlines / y ticks.
  const yTicks = [0, 1, 2, 3, 4].map((i) => yMin + (span * i) / 4);
  // Up to ~8 x labels, evenly spaced.
  const xStep = Math.max(1, Math.ceil(points.length / 8));

  const caption =
    `${FN_LABEL[fn]}` +
    (fn !== "count" && metricField ? ` · ${metricField.label}` : "") +
    ` / ${bucket === "month" ? "月" : bucket === "week" ? "週" : "日"}`;

  return (
    <div className="nk-chart">
      <div className="nk-chart-caption">{caption}</div>
      <svg
        className="nk-chart-svg"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
      >
        {yTicks.map((t, i) => (
          <g key={i}>
            <line
              className="nk-chart-grid"
              x1={M.left}
              x2={M.left + PLOT_W}
              y1={y(t)}
              y2={y(t)}
            />
            <text className="nk-chart-ylabel" x={M.left - 8} y={y(t) + 4}>
              {fmt(t)}
            </text>
          </g>
        ))}

        {area && <path className="nk-chart-area" d={areaPath} />}
        <path className="nk-chart-line" d={line} />

        {points.map((p, i) => (
          <circle key={p.key} className="nk-chart-dot" cx={x(i)} cy={y(p.value)} r={3}>
            <title>{`${bucketLabel(p.key, bucket)}: ${fmt(p.value)}`}</title>
          </circle>
        ))}

        {points.map((p, i) =>
          i % xStep === 0 || i === points.length - 1 ? (
            <text
              key={`x${p.key}`}
              className="nk-chart-xlabel"
              x={x(i)}
              y={H - 8}
              textAnchor="middle"
            >
              {bucketLabel(p.key, bucket)}
            </text>
          ) : null,
        )}
      </svg>
    </div>
  );
}
