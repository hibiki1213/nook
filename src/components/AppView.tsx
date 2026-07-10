import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
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
import { Menu } from "./Menu";
import { AppBuilderPanel } from "./AppBuilderPanel";
import { PlusIcon, MoreIcon, TrashIcon, EditIcon } from "./icons";
import { useToast } from "./Toast";
import { RelationProvider } from "./relations";
import { TableView } from "./TableView";
import { BoardView } from "./BoardView";
import { CalendarView } from "./CalendarView";
import { GalleryView } from "./GalleryView";
import { SummaryView } from "./SummaryView";
import { ChartView } from "./ChartView";
import { HeatmapView } from "./HeatmapView";
import { RecordModal } from "./RecordModal";

// `undefined` = modal closed, `null` = creating, RecordRow = editing.
type Editing = RecordRow | null | undefined;

export function AppView({
  appId,
  onDeleted,
  onChanged,
  newRecordRef,
  editAppRef,
  autoOpenBuilder = false,
}: {
  appId: string;
  onDeleted?: () => void;
  /** Name/icon changed via the builder — refresh the sidebar. */
  onChanged?: () => void;
  newRecordRef?: MutableRefObject<(() => void) | null>;
  /** Like newRecordRef: lets the command palette open the app builder. */
  editAppRef?: MutableRefObject<(() => void) | null>;
  /** Open the builder as soon as the definition loads (right after 新規アプリ). */
  autoOpenBuilder?: boolean;
}) {
  const [def, setDef] = useState<AppDefinition | null>(null);
  const [viewId, setViewId] = useState<string>("");
  const [records, setRecords] = useState<RecordRow[]>([]);
  // First-load flag so the empty state doesn't flash before records arrive.
  const [recordsLoaded, setRecordsLoaded] = useState(false);
  const [editing, setEditing] = useState<Editing>(undefined);
  const [building, setBuilding] = useState(autoOpenBuilder);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const editingRef = useRef<Editing>(undefined);
  editingRef.current = editing;
  const toast = useToast();

  // Load the definition whenever the selected app changes.
  useEffect(() => {
    let alive = true;
    setDef(null);
    setRecordsLoaded(false);
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
    setRecordsLoaded(true);
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

  // ⌘N / Ctrl+N — new record (only when no modal is open).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "n") {
        if (editingRef.current === undefined) {
          e.preventDefault();
          setEditing(null);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Let the command palette open a new record in this app.
  useEffect(() => {
    if (!newRecordRef) return;
    newRecordRef.current = () => setEditing(null);
    return () => {
      newRecordRef.current = null;
    };
  }, [newRecordRef]);

  // …and the app builder.
  useEffect(() => {
    if (!editAppRef) return;
    editAppRef.current = () => setBuilding(true);
    return () => {
      editAppRef.current = null;
    };
  }, [editAppRef]);

  if (!def) {
    return (
      <div className="nk-loading">
        <Spinner />
      </div>
    );
  }

  const view = def.views.find((v) => v.id === viewId) ?? def.views[0];

  const onSave = async (data: Record<string, unknown>, id?: number) => {
    try {
      if (id != null) await updateRecord(appId, id, data);
      else await createRecord(appId, data);
      await reload();
      toast(id != null ? "保存しました" : "追加しました", { type: "success" });
    } catch (e) {
      toast(`保存に失敗しました: ${e instanceof Error ? e.message : e}`, {
        type: "error",
      });
      throw e; // keep the modal open
    }
  };
  // Delete with an Undo affordance (HIG: destructive actions should be reversible).
  const onDelete = async (id: number) => {
    const doomed = records.find((r) => r.id === id);
    try {
      await deleteRecord(appId, id);
      await reload();
      toast("レコードを削除しました", {
        action: doomed
          ? {
              label: "取り消す",
              onClick: async () => {
                await createRecord(appId, doomed.data);
                await reload();
              },
            }
          : undefined,
      });
    } catch (e) {
      toast(`削除に失敗しました: ${e instanceof Error ? e.message : e}`, {
        type: "error",
      });
    }
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
      <header className="nk-appheader" data-tauri-drag-region>
        {/* Title/icon/description live in the sidebar — keep the header a slim
            toolbar with a draggable spacer on the left. */}
        <div className="nk-appheader-spacer" data-tauri-drag-region />
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
          <Button
            variant="primary"
            leftIcon={<PlusIcon size={16} />}
            onClick={() => setEditing(null)}
          >
            新規
          </Button>
          <Menu
            label="その他"
            align="right"
            trigger={<MoreIcon size={18} />}
            items={[
              {
                label: "アプリを編集",
                icon: <EditIcon size={15} />,
                onClick: () => setBuilding(true),
              },
              {
                label: "アプリを削除",
                danger: true,
                icon: <TrashIcon size={15} />,
                onClick: () => setConfirmDelete(true),
              },
            ]}
          />
        </div>
      </header>

      <div className="nk-appbody">
        {!recordsLoaded ? (
          <div className="nk-loading">
            <Spinner />
          </div>
        ) : view?.type === "board" ? (
          <BoardView app={def} view={view} records={records} onOpen={setEditing} />
        ) : view?.type === "calendar" ? (
          <CalendarView app={def} view={view} records={records} onOpen={setEditing} />
        ) : view?.type === "gallery" ? (
          <GalleryView
            app={def}
            view={view}
            records={records}
            onOpen={setEditing}
            onCreate={() => setEditing(null)}
          />
        ) : view?.type === "summary" ? (
          <SummaryView app={def} view={view} records={records} />
        ) : view?.type === "chart" ? (
          <ChartView app={def} view={view} records={records} />
        ) : view?.type === "heatmap" ? (
          <HeatmapView app={def} view={view} records={records} />
        ) : (
          <TableView
            app={def}
            view={view!}
            records={records}
            onOpen={setEditing}
            onToggle={onToggle}
            onCreate={() => setEditing(null)}
            onDelete={onDelete}
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

      {building && (
        <AppBuilderPanel
          app={def}
          onUpdated={(d) => {
            setDef(d);
            // A deleted view can leave viewId dangling.
            if (!d.views.some((v) => v.id === viewId)) {
              setViewId(d.views[0]?.id ?? "");
            }
            onChanged?.();
          }}
          onClose={() => setBuilding(false)}
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
