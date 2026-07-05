// Shared aggregation + date bucketing for the metric-driven views
// (summary, chart, heatmap).
import type { Bucket, MetricFn } from "../types";

export function aggregate(nums: number[], fn: MetricFn): number {
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

/** Parse a stored date value (`YYYY-MM-DD…`) into a local Date, or null. */
export function parseDate(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Sunday on/before `d` (heatmap/week grids align to weeks). */
export function weekStart(d: Date): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - x.getDay());
  return x;
}

/** Lexically-sortable bucket key for a date (day/week/month). */
export function bucketKey(d: Date, bucket: Bucket): string {
  if (bucket === "month") return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
  const b = bucket === "week" ? weekStart(d) : d;
  return `${b.getFullYear()}-${pad(b.getMonth() + 1)}-${pad(b.getDate())}`;
}

/** Compact axis label for a bucket key. */
export function bucketLabel(key: string, bucket: Bucket): string {
  const parts = key.split("-").map(Number);
  if (bucket === "month") return `${parts[0]}/${parts[1]}`;
  return `${parts[1]}/${parts[2]}`;
}
