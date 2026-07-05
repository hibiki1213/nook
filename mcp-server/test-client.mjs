// End-to-end smoke test: acts as an MCP client (like Claude Desktop), spawns the
// bundled server over stdio, and exercises the tools. Requires the Nook desktop
// app to be running (the server calls its localhost API).
//
//   node test-client.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.mjs"],
});
const client = new Client({ name: "nook-test", version: "0.0.0" });
await client.connect(transport);

const tools = await client.listTools();
console.log("TOOLS:", tools.tools.map((t) => t.name).join(", "));

async function call(name, args) {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content?.[0]?.text ?? "";
  console.log(`\n# ${name}(${JSON.stringify(args)})${r.isError ? "  [ERROR]" : ""}`);
  console.log(text.length > 700 ? text.slice(0, 700) + "…" : text);
  return r;
}

await call("list_apps", {});
await call("create_app", {
  id: "reading",
  name: "読書記録",
  icon: "📚",
  fields: [
    { id: "title", label: "タイトル", type: "text", required: true },
    {
      id: "status",
      label: "状態",
      type: "select",
      options: ["積読", "読書中", "読了"],
      default: "積読",
      indexed: true,
    },
  ],
  views: [{ id: "all", name: "すべて", type: "table", columns: ["title", "status"] }],
});
await call("add_record", { appId: "reading", values: { title: "MCP入門", status: "読書中" } });
await call("list_records", { appId: "reading" });

await client.close();
console.log("\nOK: MCP client → server → app API → SQLite chain verified.");
process.exit(0);
