import { useState } from "react";
import { Button } from "@emobi/ui";
import { Modal } from "./primitives";
import { FieldInput } from "./FieldInput";
import type { AppDefinition, RecordRow } from "../types";

/** Create (record=null) or edit an existing record, driven by the definition. */
export function RecordModal({
  app,
  record,
  onSave,
  onDelete,
  onClose,
}: {
  app: AppDefinition;
  record: RecordRow | null;
  onSave: (data: Record<string, unknown>, id?: number) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
  onClose: () => void;
}) {
  const [data, setData] = useState<Record<string, unknown>>(() => {
    if (record) return { ...record.data };
    // New record: pre-fill declared defaults.
    const d: Record<string, unknown> = {};
    for (const f of app.fields) if (f.default !== undefined) d[f.id] = f.default;
    return d;
  });
  const [saving, setSaving] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const set = (id: string, v: unknown) =>
    setData((prev) => ({ ...prev, [id]: v }));

  const save = async () => {
    setSaving(true);
    try {
      await onSave(data, record?.id);
      onClose();
    } catch {
      // onSave surfaced the error (toast); keep the modal open so edits survive.
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      variant="panel"
      onClose={onClose}
      title={
        <span>
          {app.icon} {record ? "レコードを編集" : `新規レコード — ${app.name}`}
        </span>
      }
      footer={
        <>
          {record &&
            (confirmingDelete ? (
              <>
                <span className="nk-confirm-inline">削除しますか？</span>
                <Button
                  variant="danger"
                  onClick={async () => {
                    await onDelete(record.id);
                    onClose();
                  }}
                >
                  削除する
                </Button>
                <Button variant="ghost" onClick={() => setConfirmingDelete(false)}>
                  やめる
                </Button>
              </>
            ) : (
              <Button variant="ghost" onClick={() => setConfirmingDelete(true)}>
                削除
              </Button>
            ))}
          <div style={{ flex: 1 }} />
          {!confirmingDelete && (
            <>
              <Button variant="ghost" onClick={onClose}>
                キャンセル
              </Button>
              <Button variant="primary" isLoading={saving} onClick={save}>
                保存
              </Button>
            </>
          )}
        </>
      }
    >
      <div className="nk-form">
        {app.fields.map((f) => (
          <FieldInput
            key={f.id}
            field={f}
            value={data[f.id]}
            onChange={(v) => set(f.id, v)}
          />
        ))}
      </div>
    </Modal>
  );
}
