// Manual "新規アプリ": name + icon only. The app is created immediately with a
// minimal schema (one text field, one table view) and the builder panel takes
// it from there — same grow-as-you-go shape as Claude's MCP flow.
import { useState } from "react";
import { Button, Input } from "@emobi/ui";
import { createApp } from "../api";
import type { AppDefinition } from "../types";
import { Modal } from "./primitives";
import { useToast } from "./Toast";

/** App ids are hidden (like field ids); derive a unique, safe one from time. */
function newAppId(): string {
  return `app_${Date.now().toString(36)}`;
}

export function NewAppModal({
  onCreated,
  onClose,
}: {
  /** Receives the created app's id (select it + open the builder). */
  onCreated: (appId: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [icon, setIcon] = useState("");
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const create = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    const def: AppDefinition = {
      id: newAppId(),
      name: name.trim(),
      icon: icon.trim() || undefined,
      fields: [{ id: "field_1", label: "名前", type: "text", required: true }],
      views: [{ id: "view_1", name: "一覧", type: "table" }],
    };
    try {
      await createApp(def);
      onCreated(def.id);
    } catch (e) {
      toast(`作成に失敗しました: ${e instanceof Error ? e.message : e}`, {
        type: "error",
      });
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={() => (busy ? null : onClose())}
      title="新規アプリ"
      footer={
        <>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            キャンセル
          </Button>
          <div style={{ flex: 1 }} />
          <Button
            variant="primary"
            isLoading={busy}
            disabled={!name.trim()}
            onClick={create}
          >
            作成
          </Button>
        </>
      }
    >
      <div className="nk-newapp">
        <div className="nk-builder-basics">
          <Input
            className="nk-builder-icon"
            value={icon}
            placeholder="🗂"
            aria-label="アイコン（絵文字）"
            onChange={(e) => setIcon(e.target.value)}
          />
          <Input
            value={name}
            placeholder="読書記録"
            aria-label="アプリ名"
            autoFocus
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && create()}
          />
        </div>
        <p className="nk-builder-hint">
          作成後にフィールドとビューを編集できます。アイコンは絵文字1文字
          （<kbd>ctrl</kbd>+<kbd>⌘</kbd>+<kbd>space</kbd> で絵文字パレット）。
        </p>
      </div>
    </Modal>
  );
}
