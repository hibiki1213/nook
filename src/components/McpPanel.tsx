import { useState } from "react";
import { Button } from "@emobi/ui";
import { installMcp } from "../api";

// Sidebar panel: one click repacks the MCP bundle and hands the .mcpb to Claude
// Desktop, which shows its own Install/Update dialog.
export function McpPanel() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(
    null,
  );

  const run = async () => {
    setBusy(true);
    setResult(null);
    try {
      const r = await installMcp();
      setResult({
        ok: true,
        text: `v${r.version} をパックしました。Claude Desktop のダイアログで「更新」→ アプリを再起動してください。`,
      });
    } catch (e) {
      setResult({
        ok: false,
        text: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="nk-mcp">
      <div className="nk-mcp-title">Claude Desktop 連携</div>
      <Button
        variant="secondary"
        size="sm"
        isLoading={busy}
        onClick={run}
        className="nk-mcp-btn"
      >
        {busy ? "パック中…" : "MCP を更新"}
      </Button>
      {result && (
        <div className={`nk-mcp-msg${result.ok ? " is-ok" : " is-err"}`}>
          {result.text}
        </div>
      )}
    </div>
  );
}
