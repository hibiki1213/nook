import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Spinner } from "@emobi/ui";
import {
  getApp,
  listRecords,
  createRecord,
  updateRecord,
  deleteRecord,
  deleteApp,
} from "../api";
import type { AppDefinition, RecordRow } from "../types";
import { Modal } from "./primitives";
import { RelationProvider } from "./relations";
import { TableView } from "./TableView";
import { BoardView } from "./BoardView";
import { CalendarView } from "./CalendarView";
import { GalleryView } from "./GalleryView";
import { SummaryView } from "./SummaryView";
import { RecordModal } from "./RecordModal";

// `undefined` = modal closed, `null` = creating, RecordRow = editing.
type Editing = RecordRow | null | undefined;

export function AppView({
  appId,
  onDeleted,
}: {
  appId: string;
  onDeleted?: () => void;
}) {
  const [def, setDef] = useState<AppDefinition | null>(null);
  const [viewId, setViewId] = useState<string>("");
  const [records, setRecords] = useState<RecordRow[]>([]);
  const [editing, setEditing] = useState<Editing>(undefined);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const editingRef = useRef<Editing>(undefined);
  editingRef.current = editing;

  // Load the definition whenever the selected app changes.
  useEffect(() => {
    let alive = true;
    setDef(null);
    (async () => {
      const d = await getApp(appId);
      if (!alive) return;
      setDef(d);
      setViewId(d.views[0]?.id ?? "");
    })();
    return () => {
      alive = false;
    };
  }, [appId]);

  const reload = useCallback(async () => {
    const rows = await listRecords(appId, viewId || undefined);
    setRecords(rows);
  }, [appId, viewId]);

  useEffect(() => {
    if (def) reload();
  }, [def, reload]);

  // Live refresh so records added by Claude (via MCP) appear on their own.
  // Pause while a modal is open to avoid yanking the form out from under edits.
  useEffect(() => {
    const t = setInterval(() => {
      if (editingRef.current === undefined) reload();
    }, 5000);
    return () => clearInterval(t);
  }, [reload]);

  if (!def) {
    return (
      <div className="nk-loading">
        <Spinner />
      </div>
    );
  }

  const view = def.views.find((v) => v.id === viewId) ?? def.views[0];

  const onSave = async (data: Record<string, unknown>, id?: number) => {
    if (id != null) await updateRecord(appId, id, data);
    else await createRecord(appId, data);
    await reload();
  };
  const onDelete = async (id: number) => {
    await deleteRecord(appId, id);
    await reload();
  };
  const onToggle = async (r: RecordRow, fieldId: string, checked: boolean) => {
    await updateRecord(appId, r.id, { ...r.data, [fieldId]: checked });
    await reload();
  };
  const doDelete = async () => {
    setDeleting(true);
    try {
      await deleteApp(appId);
      setConfirmDelete(false);
      onDeleted?.();
    } finally {
      setDeleting(false);
    }
  };

  return (
    <RelationProvider app={def}>
    <div className="nk-appview">
      <header className="nk-appheader">
        <div className="nk-appheader-title">
          <span className="nk-appheader-icon">{def.icon ?? "🗂"}</span>
          <div>
            <h1>{def.name}</h1>
            {def.description && <p>{def.description}</p>}
          </div>
        </div>
        <div className="nk-appheader-actions">
          {def.views.length > 1 && (
            <div className="nk-viewtabs">
              {def.views.map((v) => (
                <button
                  key={v.id}
                  className={`nk-viewtab${v.id === view?.id ? " is-active" : ""}`}
                  onClick={() => setViewId(v.id)}
                >
                  {v.name}
                </button>
              ))}
            </div>
          )}
          <Button variant="primary" onClick={() => setEditing(null)}>
            ＋ 新規
          </Button>
          <Button
            variant="ghost"
            iconOnly
            leftIcon={<span aria-hidden>🗑</span>}
            aria-label="アプリを削除"
            title="アプリを削除"
            onClick={() => setConfirmDelete(true)}
          />
        </div>
      </header>

      <div className="nk-appbody">
        {view?.type === "board" ? (
          <BoardView app={def} view={view} records={records} onOpen={setEditing} />
        ) : view?.type === "calendar" ? (
          <CalendarView app={def} view={view} records={records} onOpen={setEditing} />
        ) : view?.type === "gallery" ? (
          <GalleryView app={def} view={view} records={records} onOpen={setEditing} />
        ) : view?.type === "summary" ? (
          <SummaryView app={def} view={view} records={records} />
        ) : (
          <TableView
            app={def}
            view={view!}
            records={records}
            onOpen={setEditing}
            onToggle={onToggle}
          />
        )}
      </div>

      {editing !== undefined && (
        <RecordModal
          app={def}
          record={editing}
          onSave={onSave}
          onDelete={onDelete}
          onClose={() => setEditing(undefined)}
        />
      )}

      {confirmDelete && (
        <Modal
          open
          onClose={() => (deleting ? null : setConfirmDelete(false))}
          title={
            <span>
              {def.icon ?? "🗂"} アプリを削除
            </span>
          }
          footer={
            <>
              <Button
                variant="ghost"
                disabled={deleting}
                onClick={() => setConfirmDelete(false)}
              >
                キャンセル
              </Button>
              <div style={{ flex: 1 }} />
              <Button variant="danger" isLoading={deleting} onClick={doDelete}>
                削除する
              </Button>
            </>
          }
        >
          <p className="nk-confirm-text">
            「<b>{def.name}</b>」と、その {records.length} 件のレコードを
            すべて削除します。この操作は取り消せません。
          </p>
        </Modal>
      )}
    </div>
    </RelationProvider>
  );
}
