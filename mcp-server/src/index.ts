// Nook MCP server. Claude Desktop launches this over stdio. It holds NO database
// code and NO native dependencies — it is a thin client over the Nook desktop
// app's localhost API (the app is the sole owner of the database). This is what
// makes the extension bundle cleanly into a one-click .mcpb.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// `||` (not `??`) so an empty NOOK_API from an unset user_config still defaults.
const API = process.env.NOOK_API || "http://127.0.0.1:8765";

/** This extension's version — in lockstep with the app, which ships it inside itself. */
const EXT_VERSION = "0.5.1";
/** Contract version. Must match `API_VERSION` in `src-tauri/src/http.rs`. */
const EXT_API_VERSION = 1;

/** Negotiated once per process, so a stale extension fails loudly, not silently. */
let compatChecked = false;

async function ensureCompatible(): Promise<void> {
  if (compatChecked) return;
  const health = (await api("GET", "/health")) as {
    version?: string;
    apiVersion?: number;
  } | null;

  // Apps predating this negotiation behave like API v1.
  const appApi = typeof health?.apiVersion === "number" ? health.apiVersion : 1;
  if (appApi !== EXT_API_VERSION) {
    const appVer = health?.version ?? "不明";
    throw new Error(
      `Nook アプリ (v${appVer} / API v${appApi}) とこの拡張 (v${EXT_VERSION} / API v${EXT_API_VERSION}) に互換性がありません。` +
        `Nook アプリを最新に更新し、サイドバー下部の「Claude Desktop に接続」から拡張を入れ直してください。`,
    );
  }
  compatChecked = true;
}

/** Call the Nook app's local API. Throws a friendly error if the app is closed. */
async function api(
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  // `/health` *is* the negotiation — checking it here would recurse forever.
  if (path !== "/health") await ensureCompatible();

  let res: globalThis.Response;
  try {
    res = await fetch(`${API}${path}`, {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new Error(
      `Nook アプリに接続できませんでした (${API})。Nook デスクトップアプリを起動してから、もう一度試してください。` +
        ` [${e instanceof Error ? e.message : String(e)}]`,
    );
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const msg =
      data && typeof data === "object" && data !== null && "error" in data
        ? (data as { error: unknown }).error
        : text;
    throw new Error(String(msg));
  }
  return data;
}

const enc = encodeURIComponent;

const fieldSchema = z.object({
  id: z.string().describe("snake_case identifier, must match ^[a-z][a-z0-9_]*$"),
  label: z.string().describe("human-facing label"),
  type: z.enum([
    "text",
    "textarea",
    "number",
    "checkbox",
    "select",
    "date",
    "url",
    "money",
    "rating",
    "tags",
    "image",
    "file",
    "relation",
  ]),
  required: z.boolean().optional(),
  options: z
    .array(z.string())
    .optional()
    .describe("choices — required for `select`; optional preset labels for `tags`"),
  indexed: z
    .boolean()
    .optional()
    .describe("create a DB index on this field for fast sorting/filtering"),
  default: z.any().optional().describe("default value applied in the UI form"),
  max: z.number().int().optional().describe("max stars for a `rating` field (default 5)"),
  currency: z
    .string()
    .optional()
    .describe("ISO 4217 code for a `money` field (default JPY), e.g. 'USD'"),
  app: z
    .string()
    .optional()
    .describe(
      "REQUIRED for `relation`: target app id. The record value is the target record's integer id (find ids with list_records).",
    ),
  remind: z
    .boolean()
    .optional()
    .describe(
      "date fields only: when true, records whose date is today get an OS notification + a sidebar badge (use for due dates, renewals, watering schedules…)",
    ),
  multiple: z
    .boolean()
    .optional()
    .describe(
      "file fields only: allow several attachments per record (the stored value becomes an array)",
    ),
});

const viewSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z
    .enum(["table", "board", "calendar", "gallery", "summary", "chart", "heatmap"])
    .optional()
    .describe("defaults to table"),
  columns: z.array(z.string()).optional().describe("field ids to show (table)"),
  sort: z
    .array(z.object({ field: z.string(), dir: z.enum(["asc", "desc"]).optional() }))
    .optional(),
  groupBy: z
    .string()
    .optional()
    .describe("select field id to group by (board; also groups a summary)"),
  dateField: z.string().optional().describe("date field id to place records on (calendar)"),
  imageField: z.string().optional().describe("image field id shown as the card image (gallery)"),
  metric: z
    .object({
      field: z.string().optional().describe("number/money field to aggregate (omit for count)"),
      fn: z.enum(["sum", "avg", "count", "min", "max"]).optional(),
    })
    .optional()
    .describe("the aggregate a summary/chart/heatmap view shows"),
  chartType: z.enum(["line", "area"]).optional().describe("chart view style (default line)"),
  bucket: z
    .enum(["day", "week", "month"])
    .optional()
    .describe("chart x-axis time bucket (default day)"),
});

const ok = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
});
const fail = (e: unknown) => ({
  content: [
    { type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` },
  ],
  isError: true,
});

const server = new McpServer({ name: "nook", version: "0.2.0" });

server.tool(
  "list_apps",
  "List all apps in this Nook workspace (id, name, icon).",
  {},
  async () => {
    try {
      return ok(await api("GET", "/apps"));
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  "get_app",
  "Get the full declarative definition (fields + views) of one app.",
  { appId: z.string() },
  async ({ appId }) => {
    try {
      return ok(await api("GET", `/apps/${enc(appId)}`));
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  "create_app",
  [
    "Create a new app from a declarative definition; the app's table is materialized automatically.",
    "Field types: text, textarea, number, checkbox, select (needs `options`), date,",
    "  url (a hyperlink), money (number shown as currency; set `currency`, default JPY),",
    "  rating (stars 1..`max`, default 5), tags (multiple labels; `options` gives presets, else free-form),",
    "  image (a URL/data-URI shown as a thumbnail),",
    "  file (a PDF/image/Office attachment, previewed inline in the app. You can DEFINE",
    "    this field, but you can never attach a file — you have no access to the user's",
    "    filesystem; they drop files into the app themselves. Set `multiple: true` for",
    "    several per record, e.g. several years of past exam papers per course),",
    "  relation (a link to a record in another app: set `app` to the target app id;",
    "    record values are the target record's integer id — look ids up with list_records).",
    "Reminders: a date field with `remind: true` notifies the user (OS notification +",
    "  sidebar badge) on the day the record's date arrives — use it for 期限/更新日/次回日.",
    "View types: table, board (needs `groupBy`), calendar (needs `dateField`),",
    "  gallery (uses `imageField`), summary (aggregate via `metric`, optional `groupBy`),",
    "  chart (time-series line/area of `metric` over `dateField`; set `chartType`+`bucket`),",
    "  heatmap (GitHub-style year grid of `metric` per day over `dateField` — great for habits).",
    "Mark fields used for sorting/filtering as `indexed: true`.",
    "`id` and every field `id` must match ^[a-z][a-z0-9_]*$.",
    "Example: create_app({ id:'books', name:'読書記録', icon:'📚',",
    "  fields:[{id:'title',label:'タイトル',type:'text',required:true},",
    "          {id:'cover',label:'表紙',type:'image'},",
    "          {id:'rating',label:'評価',type:'rating',max:5,indexed:true},",
    "          {id:'genres',label:'ジャンル',type:'tags',options:['小説','技術書','漫画']}],",
    "  views:[{id:'all',name:'一覧',type:'gallery',imageField:'cover'},",
    "         {id:'byrate',name:'評価集計',type:'summary',metric:{fn:'count'},groupBy:'genres'}] })",
  ].join(" "),
  {
    id: z.string().describe("app id, ^[a-z][a-z0-9_]*$"),
    name: z.string(),
    icon: z.string().optional().describe("a single emoji"),
    description: z.string().optional(),
    fields: z.array(fieldSchema).min(1),
    views: z.array(viewSchema).optional(),
  },
  async (args) => {
    try {
      return ok(await api("POST", "/apps", args));
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  "add_field",
  "Add a new field to an existing app. Existing records get a null value for it (no data migration).",
  { appId: z.string(), field: fieldSchema },
  async ({ appId, field }) => {
    try {
      return ok(await api("POST", `/apps/${enc(appId)}/fields`, field));
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  "list_records",
  "List records for an app. Pass a viewId to apply that view's sort order.",
  { appId: z.string(), viewId: z.string().optional() },
  async ({ appId, viewId }) => {
    try {
      const q = viewId ? `?view=${enc(viewId)}` : "";
      return ok(await api("GET", `/apps/${enc(appId)}/records${q}`));
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  "add_record",
  "Add a record. `values` is an object keyed by field id (e.g. {title:'…', status:'未着手'}).",
  { appId: z.string(), values: z.record(z.any()) },
  async ({ appId, values }) => {
    try {
      return ok(await api("POST", `/apps/${enc(appId)}/records`, values));
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  "update_record",
  "Update a record by id. `values` are merged over the existing record (only provided keys change).",
  { appId: z.string(), id: z.number().int(), values: z.record(z.any()) },
  async ({ appId, id, values }) => {
    try {
      return ok(await api("PATCH", `/apps/${enc(appId)}/records/${id}`, values));
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  "delete_record",
  "Delete a record by id.",
  { appId: z.string(), id: z.number().int() },
  async ({ appId, id }) => {
    try {
      return ok(await api("DELETE", `/apps/${enc(appId)}/records/${id}`));
    } catch (e) {
      return fail(e);
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
