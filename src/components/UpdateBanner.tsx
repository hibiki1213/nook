import { useEffect, useState } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

// Sidebar footer: "a new version is available" → click to download, install and
// relaunch. It renders nothing when there is no update, and a failed *check*
// (offline, no release published yet, dev build) stays silent on purpose — an
// update banner is never worth an error dialog. A failed *install*, on the other
// hand, is something the user asked for, so that one is surfaced.
type Phase =
  | { kind: "none" }
  | { kind: "available"; update: Update }
  | { kind: "downloading"; pct: number | null }
  | { kind: "installing" }
  | { kind: "error"; message: string };

export function UpdateBanner() {
  const [phase, setPhase] = useState<Phase>({ kind: "none" });

  useEffect(() => {
    let cancelled = false;
    check()
      .then((update) => {
        if (!cancelled && update) setPhase({ kind: "available", update });
      })
      .catch(() => {
        /* offline / no release yet / dev build — stay quiet */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (phase.kind === "none") return null;

  if (phase.kind === "error") {
    return (
      <div className="nk-update is-err">更新に失敗しました: {phase.message}</div>
    );
  }

  if (phase.kind === "downloading" || phase.kind === "installing") {
    const label =
      phase.kind === "installing"
        ? "インストール中… 自動で再起動します"
        : phase.pct === null
          ? "ダウンロード中…"
          : `ダウンロード中… ${phase.pct}%`;
    return (
      <div className="nk-update is-busy">
        <span className="nk-update-text">{label}</span>
        {phase.kind === "downloading" && phase.pct !== null && (
          <span className="nk-update-bar">
            <span
              className="nk-update-bar-fill"
              style={{ width: `${phase.pct}%` }}
            />
          </span>
        )}
      </div>
    );
  }

  const { update } = phase;

  const run = async () => {
    // `Progress` reports chunk sizes, so accumulate them against the total from
    // `Started` (which some servers omit — then we just show an indeterminate label).
    let total = 0;
    let received = 0;
    setPhase({ kind: "downloading", pct: null });
    try {
      await update.downloadAndInstall((e) => {
        if (e.event === "Started") {
          total = e.data.contentLength ?? 0;
        } else if (e.event === "Progress") {
          received += e.data.chunkLength;
          setPhase({
            kind: "downloading",
            pct: total ? Math.round((received / total) * 100) : null,
          });
        } else if (e.event === "Finished") {
          setPhase({ kind: "installing" });
        }
      });
      await relaunch();
    } catch (err) {
      setPhase({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return (
    <button
      type="button"
      className="nk-update is-available"
      onClick={run}
      title={update.body || `v${update.version} に更新します`}
    >
      <span className="nk-update-dot" />
      <span className="nk-update-text">
        <span>
          新しいバージョン <b>v{update.version}</b>
        </span>
        <span className="nk-update-sub">クリックで更新</span>
      </span>
    </button>
  );
}
