import { useState } from "react";
import { Button } from "@emobi/ui";
import { installMcp } from "../api";

// Sidebar panel: hands the app-bundled .mcpb to Claude Desktop, which shows its own
// Install/Update dialog. The bundle ships inside the app, so there is nothing to
// build here and no Node/pnpm needed on the user's machine.
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
        text: `Claude Desktop のダイアログで「インストール」を選び、Claude Desktop を再起動してください。(v${r.version})`,
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
        {busy ? "準備中…" : "Claude Desktop に接続"}
      </Button>
      {result && (
        <div className={`nk-mcp-msg${result.ok ? " is-ok" : " is-err"}`}>
          {result.text}
        </div>
      )}
    </div>
  );
}
