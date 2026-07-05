# App Definition — the shared spec

An **app** in Nook is pure data: a declarative definition stored as JSON. There is
no per-app code.

The **desktop app (`src-tauri/`, Rust) is the sole owner** of the database and the
only place these rules are implemented (`src-tauri/src/db.rs` + `repo.rs`). It reads
apps, renders them, and does all CRUD.

Claude Desktop drives Nook through **`mcp-server/`** — a pure-JS MCP server that is a
thin client of the app's localhost API (`http://127.0.0.1:8765`). It contains no
storage logic; every operation is an HTTP call the app fulfills. So there is a single
implementation of the spec below, and a single writer.

The database file (macOS):

```
~/Library/Application Support/com.nook.app/nook.db
```

## Definition shape

```jsonc
{
  "id": "tasks",              // ^[a-z][a-z0-9_]*$ — used to derive the table name
  "name": "タスク管理",
  "icon": "✅",               // single emoji (optional)
  "description": "…",         // optional
  "fields": [
    {
      "id": "status",          // ^[a-z][a-z0-9_]*$ — JSON key + generated column
      "label": "ステータス",
      // text | textarea | number | checkbox | select | date
      // | url | money | rating | tags | image | relation
      "type": "select",
      "required": false,        // optional
      "options": ["未着手","進行中","完了"],  // required for `select`; preset labels for `tags`
      "indexed": true,          // optional — create a DB index on this field
      "default": "未着手",      // optional — pre-filled in the UI form
      "max": 5,                 // optional — stars for `rating` (default 5)
      "currency": "JPY",        // optional — ISO 4217 for `money` (default JPY)
      "app": "books",           // required for `relation` — target app id
      "remind": true            // date fields only — notify when the date arrives
    }
  ],
  "views": [
    {
      "id": "all",
      "name": "すべて",
      // table | board | calendar | gallery | summary | chart | heatmap
      "type": "table",
      "columns": ["status"],    // table: field ids shown as columns
      "sort": [{ "field": "status", "dir": "asc" }],
      "groupBy": "status",      // board: select-field id to group by
      "dateField": "due",       // calendar/chart/heatmap: date-field id
      "imageField": "cover",    // gallery: image-field id used as the card image
      "metric": { "field": "amount", "fn": "sum" },  // summary/chart/heatmap aggregate (fn: sum|avg|count|min|max)
      "chartType": "line",      // chart: line | area
      "bucket": "month"         // chart x-axis bucket: day | week | month
    }
  ]
}
```

### Views

- **table** — columns + sort.
- **board** — kanban grouped by the `groupBy` select field.
- **calendar** — month grid placing records on their `dateField` (a `date` field);
  falls back to the first date field if unset.
- **gallery** — card grid using `imageField` (an `image` field) as the cover;
  falls back to the first image field, and uses the first text field as the title.
- **summary** — aggregate `metric` (`fn` over a number/`money` `field`; `count`
  needs no field) shown as a total, and — when `groupBy` is set — broken down per
  group with bars. A `money` metric field formats the result as currency.
- **chart** — the `metric` aggregated over time: one point per `bucket`
  (`day`/`week`/`month`) of `dateField`, drawn as a `line` or `area` (`chartType`).
  For trends — weight, spending, mood over time.
- **heatmap** — a GitHub-contribution-style year grid coloring each day by the
  `metric` over `dateField` (`count` by default). For habit/streak tracking.
  Only same-day intensity; navigate years in the toolbar.

## Storage model — JSON + generated columns

Each app gets a physical table named `d_<appId>`:

```sql
CREATE TABLE "d_tasks" (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  data        TEXT NOT NULL DEFAULT '{}',       -- the record, as a JSON object
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  -- one VIRTUAL generated column per field:
  "f_status"  TEXT GENERATED ALWAYS AS (json_extract(data, '$.status')) VIRTUAL
);
CREATE INDEX "ix_tasks_status" ON "d_tasks" ("f_status");  -- when indexed: true
```

- **Canonical data lives in `data` (JSON).** Generated columns are derived views of
  it, used only to make sorting/filtering fast. Records are always written as a
  whole JSON object via `json(?)`.
- **Adding a field never migrates data.** `ALTER TABLE … ADD COLUMN … GENERATED …`
  and existing rows immediately get the computed value (NULL if the key is absent).
- **Column affinity by type:** `number | money | rating → REAL`,
  `checkbox → INTEGER`, everything else (`text`, `textarea`, `select`, `date`,
  `url`, `tags`) `→ TEXT`.
- **Value shapes.** Most fields store a scalar. `money` and `rating` store a
  **number** (rating is `1..=max`). `tags` stores a **JSON array of strings**, so
  its generated column mirrors the array's JSON text — good for display, not for
  range sorting. `url` and `image` store a string (a URL / data-URI). An `image`
  value may also be `nook-img://<filename>` — a file picked from the PC in the
  UI, copied into `~/Library/Application Support/com.nook.app/images/` and
  served to the renderer over Tauri's asset protocol. Claude (MCP) keeps writing
  plain URLs; both forms coexist. `relation` stores the **target record's
  integer id** in the app named by the field's `app`; the renderer shows the
  target's title (its first text field). There is no referential integrity:
  deleting the target record/app leaves a dangling id, shown as `#<id>`.

## Reminders

A `date` field with `remind: true` marks records as **due** on the day the
stored date equals today (local time). Two surfaces, both implemented in the
desktop app (`src-tauri/src/reminders.rs`):

- a per-app badge in the sidebar (the UI polls `due_counts`), and
- one OS notification per app per day while the app is running (a background
  thread scans every 5 minutes; dedupe state lives in the `settings` table, so
  restarting the app the same day does not re-notify).

Overdue (past) dates are deliberately not notified — only same-day.
- **Detecting existing columns uses `PRAGMA table_xinfo`, not `table_info`** —
  `table_info` omits generated columns, which would cause duplicate-column errors on
  the next `ensure_table`.

## Identifier safety

`id` (app and field) is interpolated into DDL/DML where it can't be a bound
parameter, so it is strictly validated against `^[a-z][a-z0-9_]*$` (≤ 40 chars).
All record **values** are always bound as parameters.
