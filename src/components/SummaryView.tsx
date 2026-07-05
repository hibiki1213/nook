import { Card } from "@emobi/ui";
import { formatMoney } from "../lib/format";
import { barColor } from "../lib/palette";
import type { AppDefinition, Field, MetricFn, RecordRow, View } from "../types";

const FN_LABEL: Record<MetricFn, string> = {
  sum: "合計",
  avg: "平均",
  count: "件数",
  min: "最小",
  max: "最大",
};

function aggregate(nums: number[], fn: MetricFn): number {
  if (fn === "count") return nums.length;
  if (!nums.length) return 0;
  switch (fn) {
    case "sum":
      return nums.reduce((a, b) => a + b, 0);
    case "avg":
      return nums.reduce((a, b) => a + b, 0) / nums.length;
    case "min":
      return Math.min(...nums);
    case "max":
      return Math.max(...nums);
  }
}

/** Format an aggregate for display, honoring a money metric field's currency. */
function fmt(value: number, fn: MetricFn, field?: Field): string {
  if (fn === "count") return `${value} 件`;
  if (field?.type === "money") return formatMoney(value, field.currency);
  const rounded = fn === "avg" ? Math.round(value * 10) / 10 : value;
  return rounded.toLocaleString();
}

interface Group {
  key: string;
  value: number;
  count: number;
  color: string;
  /** Weight for the proportional bar / percentage (share of the total). */
  share: number;
}

/**
 * Aggregated totals with a single proportional (stacked) bar + per-group ticked
 * bars. Bar design ported from vibeteam's dashboard: rounded segments with 4px
 * gaps for the ratio bar; thin vertical ticks for per-group progress.
 */
export function SummaryView({
  app,
  view,
  records,
}: {
  app: AppDefinition;
  view: View;
  records: RecordRow[];
}) {
  const fn: MetricFn = view.metric?.fn ?? "count";
  const metricField = app.fields.find((f) => f.id === view.metric?.field);
  const groupField = app.fields.find((f) => f.id === view.groupBy);

  const numbers = (rows: RecordRow[]): number[] => {
    if (fn === "count") return rows.map(() => 0); // length is all that matters
    if (!metricField) return [];
    return rows
      .map((r) => Number(r.data[metricField.id]))
      .filter((n) => Number.isFinite(n));
  };

  const total = aggregate(numbers(records), fn);

  if (fn !== "count" && !metricField) {
    return (
      <div className="nk-empty-state">
        集計には metric.field（数値/金額フィールド）が必要です。
      </div>
    );
  }

  // Grouped breakdown, if a groupBy select field is configured.
  let groups: Group[] = [];
  if (groupField) {
    const order = groupField.options ?? [];
    const buckets = new Map<string, RecordRow[]>();
    for (const r of records) {
      const raw = r.data[groupField.id];
      const k = raw == null || raw === "" ? "未分類" : String(raw);
      (buckets.get(k) ?? buckets.set(k, []).get(k)!).push(r);
    }
    const keys = [
      ...order.filter((o) => buckets.has(o)),
      ...[...buckets.keys()].filter((k) => !order.includes(k)),
    ];
    // Shares only make sense for additive aggregates; for avg/min/max the bar
    // weights fall back to record counts (still a meaningful "volume" ratio).
    const additive = fn === "sum" || fn === "count";
    const weights = keys.map((k) => {
      const rows = buckets.get(k)!;
      return additive
        ? Math.max(0, aggregate(numbers(rows), fn))
        : rows.length;
    });
    const weightTotal = weights.reduce((a, b) => a + b, 0);
    groups = keys.map((k, i) => {
      const rows = buckets.get(k)!;
      return {
        key: k,
        value: aggregate(numbers(rows), fn),
        count: rows.length,
        color: barColor(k, order),
        share: weightTotal > 0 ? weights[i] / weightTotal : 0,
      };
    });
  }

  const metricLabel = metricField ? metricField.label : "レコード";
  const pct = (share: number) => `${Math.round(share * 100)}%`;

  return (
    <div className="nk-summary">
      <Card shadow className="nk-summary-total">
        <div className="nk-summary-total-label">
          {FN_LABEL[fn]}
          {fn !== "count" && ` · ${metricLabel}`}
          {groupField && ` / ${groupField.label}別`}
        </div>
        <div className="nk-summary-total-value">{fmt(total, fn, metricField)}</div>
        <div className="nk-summary-total-sub">{records.length} 件のレコード</div>
      </Card>

      {groups.length > 0 && (
        <>
          {/* One proportional bar: rounded segments, 4px gaps (vibeteam style). */}
          <div className="nk-ratio">
            {groups.some((g) => g.share > 0) ? (
              <div className="nk-ratio-bar">
                {groups
                  .filter((g) => g.share > 0)
                  .map((g) => (
                    <div
                      key={g.key}
                      className="nk-ratio-seg"
                      style={{ flexGrow: g.share, background: g.color }}
                      title={`${g.key} · ${fmt(g.value, fn, metricField)} (${pct(g.share)})`}
                    />
                  ))}
              </div>
            ) : (
              <div className="nk-ratio-bar is-empty">データなし</div>
            )}
            <div className="nk-ratio-legend">
              {groups.map((g) => (
                <span key={g.key} className="nk-legend-item">
                  <span className="nk-legend-dot" style={{ background: g.color }} />
                  {g.key}
                  <span className="nk-legend-pct">{pct(g.share)}</span>
                </span>
              ))}
            </div>
          </div>

          {/* Per-group rows with ticked bars (vibeteam task-card style). */}
          <div className="nk-summary-groups">
            {groups.map((g) => (
              <div key={g.key} className="nk-summary-row">
                <div className="nk-summary-row-head">
                  <span className="nk-summary-key">
                    <span className="nk-legend-dot" style={{ background: g.color }} />
                    {g.key}
                  </span>
                  <span className="nk-summary-val">{fmt(g.value, fn, metricField)}</span>
                </div>
                <div className="nk-ticks">
                  <div
                    className="nk-ticks-fill"
                    style={{
                      width: `${Math.min(100, g.share * 100)}%`,
                      color: g.color,
                    }}
                  />
                </div>
                <div className="nk-summary-count">
                  {g.count} 件 · {pct(g.share)}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
