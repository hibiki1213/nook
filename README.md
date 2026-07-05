# Nook

A personal, local-first **"kintone you build with Claude."** Ask Claude Desktop to
build small apps (task tracker, reading log, habit tracker…), and use them in a
native desktop app. Your data stays in a single SQLite file on your machine.

- **Declarative, not code-gen.** An app is a JSON definition (fields + views). A
  generic engine renders it — so what Claude authors is safe, inspectable, and
  reversible.
- **Local-first.** Data lives in `~/Library/Application Support/com.nook.app/nook.db`.
  (Claude runs in the cloud, so only the schema + the records relevant to a request
  are ever sent to it — never the whole database.)
- **Built on** Tauri (Rust) + React + [`@emobi/ui`](../Downloads/twent-ui) design system.

## Architecture

The **Nook app owns the database** and is its only writer. It exposes a tiny
localhost API. The MCP server that Claude Desktop launches is a **pure-JS client**
of that API — it holds no database code and no native dependencies, which is what
lets it ship as a one-click `.mcpb` extension.

```
Claude Desktop ──stdio (MCP)──►  mcp-server  (pure JS, no native deps)
                                      │  fetch → http://127.0.0.1:8765
                                      ▼
                               Nook app (Rust)  ★ sole DB owner
                                      │  rusqlite
                                      ▼
                               nook.db (SQLite)  ← JSON `data` + generated columns + indexes
                                      ▲
                                      │  invoke (in-process)
                               src/ (React renderer + @emobi/ui)
```

An app definition is materialized into a per-app table `d_<appId>`: canonical data
in a JSON `data` column, plus a `GENERATED ALWAYS … VIRTUAL` column (indexed on
demand) per field for fast sort/filter. See
[docs/app-definition.md](docs/app-definition.md) for the spec.

> Because the MCP server talks to the app over HTTP, **the Nook app must be running**
> for Claude to build or edit apps. (This is the deliberate trade for a rock-solid,
> native-dependency-free extension. See the design history in the notes below.)

## Prerequisites

- **Rust** (stable) — `curl https://sh.rustup.rs -sSf | sh`
- **Node 20+** and **pnpm**
- macOS (the DB path in `db.rs` assumes macOS; adjust for other OSes)

## Setup

```bash
# 1. Design system (consumed as a local file: dependency)
cd ../Downloads/twent-ui && pnpm install && pnpm build

# 2. Desktop app
cd -                       # back to this repo
pnpm install

# 3. MCP server (pure JS — bundles to a single self-contained file)
cd mcp-server && pnpm install && pnpm build && cd ..
```

## Run the app

```bash
pnpm tauri dev
```

On first launch it seeds a **タスク管理** (task management) sample app. The local API
comes up on `http://127.0.0.1:8765` (logged to stderr). Apps and records that Claude
creates over MCP appear in the UI automatically (it polls every few seconds).

## Connect Claude Desktop

### Option A — one-click install (recommended)

Build the bundle, then double-click it:

```bash
cd mcp-server && pnpm pack:mcpb   # produces nook.mcpb
```

Open `nook.mcpb` → Claude Desktop shows an **Install** dialog → done. Claude Desktop
runs it with its **built-in Node**, so there's nothing else to install. (Extensions
were formerly called DXT; the format is now `.mcpb`.)

### Option B — manual config (dev)

Point Claude Desktop's config at the bundled entry point:

`~/Library/Application Support/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "nook": {
      "command": "node",
      "args": ["/Users/hibiki_ceo/whitesharp/mcp-server/dist/index.mjs"]
    }
  }
}
```

Restart Claude Desktop. Then say things like:

> 読書記録アプリを作って。タイトル・著者・評価（5段階）・読了フラグ・感想メモのフィールドで。

Claude calls `create_app`, and the app shows up in Nook's sidebar within a few
seconds. Then: *"『SICP』を評価5、読了で追加して"* → `add_record`.

### Tools Claude gets

`list_apps` · `get_app` · `create_app` · `add_field` · `list_records` ·
`add_record` · `update_record` · `delete_record`

## Project layout

```
src/                 React renderer — the generic engine (reads definitions, renders views/forms)
  components/         Sidebar, AppView, TableView, BoardView, RecordModal, FieldInput/Value…
src-tauri/src/       Rust backend
  models.rs          the declarative model (Field, View, AppDefinition)
  db.rs              SQLite: table materialization, generated columns, indexes
  repo.rs            all data operations (shared by UI commands + the local API)
  commands.rs        Tauri commands for the in-app UI (thin wrappers over repo)
  http.rs            localhost API (127.0.0.1:8765) the MCP server calls
  seed.rs            first-run task-management app
mcp-server/          Node MCP server Claude Desktop connects to
  src/index.ts       pure-JS tools → fetch the app's local API (no DB code)
  manifest.json      .mcpb extension manifest
docs/app-definition.md   the shared declarative spec
```

## Notes / current limits (MVP)

- Field types: text, textarea, number, checkbox, select, date, url, money
  (currency-formatted number), rating (stars), tags (multi-label), image
  (thumbnail; pick from PC or URL), relation (link to another app's record).
- Views: table (columns + sort), board (group by a select field), calendar (by a
  date field), gallery (image cards), and summary (aggregate a number/money field,
  optionally grouped). No drag-and-drop yet.
- **Single writer:** the Nook app is the only process that opens SQLite, so there's no
  cross-process contention to reason about. The MCP server is a stateless HTTP client.
- **Why this shape?** The MCP extension must be free of native modules
  (`better-sqlite3` crashes inside Claude Desktop's sandboxed runtime — ABI + macOS
  code-signing). Making the app the DB owner and the extension a thin client removes
  the native dependency entirely and keeps a single source of truth.
```
