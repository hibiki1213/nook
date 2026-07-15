// P2P sharing UI: start sharing an app (with relation-dependency confirmation
// and the attachment warning), show/copy the invite ticket, list members with
// last-sync times, remove members, leave. JoinShareModal is the paste-a-ticket
// counterpart, app-independent.
import { useCallback, useEffect, useState } from "react";
import { Button, Input } from "@emobi/ui";
import {
  createInvite,
  getDeviceName,
  joinShare,
  leaveShare,
  removeMember,
  setDeviceName,
  sharePreview,
  shareApp,
  shareStatus,
} from "../api";
import type {
  AppDefinition,
  SharePreview,
  ShareStatus,
} from "../types";
import { Modal } from "./primitives";
import { useToast } from "./Toast";

function useAppShareStatus(appId: string) {
  const [status, setStatus] = useState<ShareStatus | null | undefined>(undefined);
  const refresh = useCallback(async () => {
    try {
      const all = await shareStatus();
      setStatus(all.find((s) => s.appId === appId) ?? null);
    } catch {
      setStatus(null);
    }
  }, [appId]);
  useEffect(() => {
    void refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [refresh]);
  return { status, refresh };
}

function TicketBox({ ticket }: { ticket: string }) {
  const toast = useToast();
  return (
    <div className="nk-ticket">
      <textarea
        className="nk-ticket-text"
        readOnly
        value={ticket}
        rows={3}
        onFocus={(e) => e.target.select()}
      />
      <Button
        onClick={async () => {
          await navigator.clipboard.writeText(ticket);
          toast("チケットをコピーしました", { type: "success" });
        }}
      >
        チケットをコピー
      </Button>
      <div className="nk-hint">
        このチケットを持っている人は誰でも参加できます。信頼できる相手にだけ、
        直接送ってください。
      </div>
    </div>
  );
}

export function ShareModal({
  app,
  onClose,
  onChanged,
}: {
  app: AppDefinition;
  onClose: () => void;
  /** Sharing state changed (started/left) — refresh app lists etc. */
  onChanged?: () => void;
}) {
  const toast = useToast();
  const { status, refresh } = useAppShareStatus(app.id);
  const [preview, setPreview] = useState<SharePreview | null>(null);
  const [includeApps, setIncludeApps] = useState<Record<string, boolean>>({});
  const [name, setName] = useState("");
  const [ticket, setTicket] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmingLeave, setConfirmingLeave] = useState(false);

  useEffect(() => {
    void sharePreview(app.id).then(setPreview).catch(() => setPreview(null));
    void getDeviceName().then((n) => setName(n ?? "")).catch(() => {});
  }, [app.id]);

  const start = async () => {
    setBusy(true);
    try {
      if (name.trim()) await setDeviceName(name.trim());
      const ids = [
        app.id,
        ...Object.entries(includeApps)
          .filter(([, on]) => on)
          .map(([id]) => id),
      ];
      const t = await shareApp(ids);
      setTicket(t);
      await refresh();
      onChanged?.();
      toast("共有を開始しました", { type: "success" });
    } catch (e) {
      toast(`共有を開始できません: ${e instanceof Error ? e.message : e}`, {
        type: "error",
      });
    } finally {
      setBusy(false);
    }
  };

  const issueTicket = async () => {
    try {
      setTicket(await createInvite(app.id));
    } catch (e) {
      toast(`チケットを発行できません: ${e instanceof Error ? e.message : e}`, {
        type: "error",
      });
    }
  };

  const leave = async () => {
    setBusy(true);
    try {
      await leaveShare(app.id);
      onChanged?.();
      toast("共有をやめました(データは手元に残っています)");
      onClose();
    } catch (e) {
      toast(`失敗しました: ${e instanceof Error ? e.message : e}`, { type: "error" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      variant="panel"
      onClose={onClose}
      title={
        <span>
          {app.icon} {app.name} を共有
        </span>
      }
    >
      {status === undefined ? null : status === null ? (
        // ── Not shared yet ────────────────────────────────────────────────
        <div className="nk-share">
          <p className="nk-share-lede">
            このアプリを他の人と一緒に使えるようにします。データは互いの Mac の間で
            直接同期され、クラウドには保存されません。全員がデータの完全なコピーを
            持ち、オフラインでも編集できます。
          </p>
          <Input
            label="あなたの表示名(メンバー一覧に表示)"
            value={name}
            placeholder="例: ヒビキ"
            onChange={(e) => setName(e.target.value)}
          />
          {preview && preview.relatedApps.length > 0 && (
            <div className="nk-share-block">
              <div className="nk-label">関連アプリ</div>
              <div className="nk-hint">
                このアプリは以下のアプリのレコードを参照しています。一緒に共有しない
                場合、相手には参照が「#…」と表示されます。
              </div>
              {preview.relatedApps.map((a) => (
                <label key={a.id} className="nk-share-check">
                  <input
                    type="checkbox"
                    checked={includeApps[a.id] ?? false}
                    onChange={(e) =>
                      setIncludeApps((m) => ({ ...m, [a.id]: e.target.checked }))
                    }
                  />
                  <span>
                    {a.icon ?? "🗂"} {a.name} も一緒に共有する
                  </span>
                </label>
              ))}
            </div>
          )}
          {preview?.hasAttachments && (
            <div className="nk-share-warn">
              ⚠️ このアプリには添付ファイル/画像フィールドがあります。現在の
              バージョンでは<b>ファイルの実体は同期されません</b>(相手には
              ファイル名だけが見えます)。
            </div>
          )}
          <Button variant="primary" disabled={busy} onClick={start}>
            共有を開始してチケットを発行
          </Button>
        </div>
      ) : (
        // ── Already shared ────────────────────────────────────────────────
        <div className="nk-share">
          <div className="nk-share-statusrow">
            <span
              className={`nk-share-dot${status.connectedPeers > 0 ? " is-on" : ""}`}
            />
            {status.connectedPeers > 0
              ? `${status.connectedPeers} 台と接続中`
              : "接続中のメンバーはいません"}
            {status.pendingOut > 0 && (
              <span className="nk-share-pending">
                未送信の変更 {status.pendingOut} 件
              </span>
            )}
          </div>

          <div className="nk-share-block">
            <div className="nk-label">メンバー</div>
            {status.members.length === 0 && (
              <div className="nk-hint">まだ誰も参加していません。</div>
            )}
            {status.members.map((m) => (
              <div key={m.deviceId} className="nk-share-member">
                <span className="nk-share-member-name">
                  {m.name || `端末 ${m.deviceId.slice(0, 6)}`}
                  {m.isSelf && <span className="nk-share-self">(自分)</span>}
                </span>
                <span className="nk-share-member-sync">
                  {m.isSelf ? "" : m.lastSyncAt ? `最終同期 ${m.lastSyncAt}` : "未同期"}
                </span>
                {!m.isSelf && (
                  <Button
                    variant="ghost"
                    onClick={async () => {
                      try {
                        await removeMember(app.id, m.deviceId);
                        await refresh();
                        toast(
                          "メンバーを外し、鍵を更新しました。相手の手元に残った既存データは消せません",
                        );
                      } catch (e) {
                        toast(`失敗しました: ${e instanceof Error ? e.message : e}`, {
                          type: "error",
                        });
                      }
                    }}
                  >
                    外す
                  </Button>
                )}
              </div>
            ))}
          </div>

          <div className="nk-share-block">
            <div className="nk-label">招待</div>
            {ticket ? (
              <TicketBox ticket={ticket} />
            ) : (
              <Button onClick={issueTicket}>招待チケットを発行</Button>
            )}
          </div>

          <div className="nk-share-block">
            {confirmingLeave ? (
              <div className="nk-share-leave">
                <span className="nk-confirm-inline">
                  共有をやめますか？(データは手元に残ります)
                </span>
                <Button variant="danger" disabled={busy} onClick={leave}>
                  やめる
                </Button>
                <Button variant="ghost" onClick={() => setConfirmingLeave(false)}>
                  戻る
                </Button>
              </div>
            ) : (
              <Button variant="ghost" onClick={() => setConfirmingLeave(true)}>
                このアプリの共有をやめる…
              </Button>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

export function JoinShareModal({
  onClose,
  onJoined,
}: {
  onClose: () => void;
  onJoined: (appIds: string[]) => void;
}) {
  const toast = useToast();
  const [ticket, setTicket] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void getDeviceName().then((n) => setName(n ?? "")).catch(() => {});
  }, []);

  const join = async () => {
    setBusy(true);
    try {
      if (name.trim()) await setDeviceName(name.trim());
      const apps = await joinShare(ticket.trim());
      toast("共有に参加しました。同期中…", { type: "success" });
      onJoined(apps);
      onClose();
    } catch (e) {
      toast(`参加できません: ${e instanceof Error ? e.message : e}`, {
        type: "error",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open variant="panel" onClose={onClose} title="共有アプリに参加">
      <div className="nk-share">
        <p className="nk-share-lede">
          受け取った招待チケット(nook1… で始まる文字列)を貼り付けてください。
          発行した人がオンラインのときに参加できます。
        </p>
        <Input
          label="あなたの表示名(メンバー一覧に表示)"
          value={name}
          placeholder="例: ユイ"
          onChange={(e) => setName(e.target.value)}
        />
        <div className="nk-field">
          <label className="nk-label">招待チケット</label>
          <textarea
            className="nk-ticket-text"
            rows={4}
            value={ticket}
            placeholder="nook1…"
            onChange={(e) => setTicket(e.target.value)}
          />
        </div>
        <Button
          variant="primary"
          disabled={busy || !ticket.trim()}
          onClick={join}
        >
          参加する
        </Button>
      </div>
    </Modal>
  );
}
