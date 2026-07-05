// TypeScript mirror of the declarative app-definition model (see
// `src-tauri/src/models.rs` and `docs/app-definition.md`). The renderer reads
// these — it never hard-codes any particular app's shape.

export type FieldType =
  | "text"
  | "textarea"
  | "number"
  | "checkbox"
  | "select"
  | "date"
  | "url"
  | "money"
  | "rating"
  | "tags"
  | "image"
  | "relation";

export interface Field {
  id: string;
  label: string;
  type: FieldType;
  required?: boolean;
  options?: string[];
  indexed?: boolean;
  default?: unknown;
  /** Max stars for a `rating` field (default 5). */
  max?: number;
  /** ISO 4217 currency code for a `money` field (default "JPY"). */
  currency?: string;
  /** Target app id for a `relation` field. */
  app?: string;
  /** date fields: badge + OS-notify when the date arrives. */
  remind?: boolean;
}

/** Per-app "due today" count (reminded date fields). */
export interface DueApp {
  appId: string;
  appName: string;
  count: number;
}

export interface SortSpec {
  field: string;
  dir?: "asc" | "desc";
}

export type MetricFn = "sum" | "avg" | "count" | "min" | "max";

export interface Metric {
  /** Field id to aggregate. Ignored when `fn` is "count". */
  field?: string;
  fn?: MetricFn;
}

export type ChartType = "line" | "area";
export type Bucket = "day" | "week" | "month";

export interface View {
  id: string;
  name: string;
  type?: "table" | "board" | "calendar" | "gallery" | "summary" | "chart" | "heatmap";
  columns?: string[];
  sort?: SortSpec[];
  /** select-field id to group by (board; also summary grouping). */
  groupBy?: string;
  /** date-field id records are placed on (calendar; x-axis for chart/heatmap). */
  dateField?: string;
  /** image-field id shown as the card image (gallery). */
  imageField?: string;
  /** aggregate shown by a summary/chart/heatmap view. */
  metric?: Metric;
  /** chart style (chart view). */
  chartType?: ChartType;
  /** time bucket for a chart x-axis (chart view). */
  bucket?: Bucket;
}

export interface AppDefinition {
  id: string;
  name: string;
  icon?: string;
  description?: string;
  fields: Field[];
  views: View[];
}

export interface AppSummary {
  id: string;
  name: string;
  icon?: string | null;
}

export interface RecordRow {
  id: number;
  data: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}
