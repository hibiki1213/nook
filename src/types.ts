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
  | "file"
  | "relation";

/**
 * What a `file` field stores. Unlike `image` (a bare URL string) we keep the
 * original filename — `2023年度_期末.pdf` is the whole point of an attachment.
 * A `multiple` file field stores an array of these.
 */
export interface FileRef {
  /** `nook-file://<stored-name>` — resolve via `lib/files.ts`. */
  ref: string;
  /** Original filename, shown in the UI. */
  name: string;
  size: number;
}

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
  /** `file` fields: allow several attachments (the value becomes `FileRef[]`). */
  multiple?: boolean;
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
  type?:
    | "table"
    | "board"
    | "calendar"
    | "gallery"
    | "summary"
    | "chart"
    | "heatmap"
    | "page";
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
  /** ordered ids of other views stacked on the page, top to bottom (page view). */
  blocks?: string[];
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
