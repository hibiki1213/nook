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
import { parseBlock } from "../lib/blocks";
import { Modal } from "./primitives";
import { Menu } from "./Menu";
import { AppBuilderPanel } from "./AppBuilderPanel";
import { PlusIcon, MoreIcon, TrashIcon, EditIcon } from "./icons";
import { useToast } from "./Toast";
import { RelationProvider } from "./relations";
import { ViewBody, type ViewHandlers } from "./ViewBody";
import { PageView } from "./PageView";
import { RecordModal } from "./RecordModal";

// What the record modal is editing. `undefined` = closed; otherwise the target
// app (which may be a foreign app referenced by a page block) plus the record
// (null = creating).
type EditTarget = { app: AppDefinition; record: RecordRow | null };

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
  // Page views: per-block record sets keyed by the block ref string (each block
  // loads with its own view's sort, from its own app).
  const [blockRecords, setBlockRecords] = useState<Record<string, RecordRow[]>>({});
  // Definitions of other apps referenced by the current page's blocks.
  const [foreignDefs, setForeignDefs] = useState<Record<string, AppDefinition>>({});
  // First-load flag so the empty state doesn't flash before records arrive.
  const [recordsLoaded, setRecordsLoaded] = useState(false);
  const [editing, setEditing] = useState<EditTarget | undefined>(undefined);
  const [building, setBuilding] = useState(autoOpenBuilder);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const editingRef = useRef<EditTarget | undefined>(undefined);
  editingRef.current = editing;
  // defRef keeps the keydown/command-palette closures reading the live def
  // without re-subscribing on every definition edit.
  const defRef = useRef<AppDefinition | null>(null);
  defRef.current = def;
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
    const v = def?.views.find((x) => x.id === viewId) ?? def?.views[0];
    // Distinct block refs of the current page (if any), resolved to app+view.
    const refs =
      v?.type === "page"
        ? [...new Set(v.blocks ?? [])].map((ref) => ({
            ref,
            ...parseBlock(ref, appId),
          }))
        : [];
    // Foreign app definitions needed to render the blocks.
    const foreignIds = [
      ...new Set(refs.filter((r) => r.foreign).map((r) => r.appId)),
    ];
    const [rows, defs, ...blockRows] = await Promise.all([
      listRecords(appId, viewId || undefined),
      Promise.all(
        foreignIds.map((id) =>
          getApp(id)
            .then((d) => [id, d] as const)
            .catch(() => null),
        ),
      ),
      ...refs.map((r) => listRecords(r.appId, r.viewId).catch(() => [])),
    ]);
    setRecords(rows);
    setForeignDefs(Object.fromEntries(defs.filter(Boolean) as [string, AppDefinition][]));
    setBlockRecords(
      Object.fromEntries(refs.map((r, i) => [r.ref, blockRows[i]])),
    );
    setRecordsLoaded(true);
  }, [appId, viewId, def]);

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

  // ⌘N / Ctrl+N — new record in this app (only when no modal is open).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "n") {
        if (editingRef.current === undefined && defRef.current) {
          e.preventDefault();
          setEditing({ app: defRef.current, record: null });
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Let the command palette open a new record in this app.
  useEffect(() => {
    if (!newRecordRef) return;
    newRecordRef.current = () => {
      if (defRef.current) setEditing({ app: defRef.current, record: null });
    };
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

  // ── Record mutations, parameterized by the target app so page blocks that
  //    show another app's data edit the right records. ──────────────────────

  // Optimistic local patch, scoped to the slices belonging to `tAppId` (record
  // ids are only unique within one app, so we must not patch across apps).
  const patchSlices = (tAppId: string, id: number, data: Record<string, unknown>) => {
    const patch = (rows: RecordRow[]) =>
      rows.map((row) => (row.id === id ? { ...row, data } : row));
    if (tAppId === appId) setRecords(patch);
    setBlockRecords((m) =>
      Object.fromEntries(
        Object.entries(m).map(([ref, rows]) => [
          ref,
          parseBlock(ref, appId).appId === tAppId ? patch(rows) : rows,
        ]),
      ),
    );
  };

  // Find a record (for the delete-undo affordance) within `tAppId`'s slices.
  const findRecord = (tAppId: string, id: number): RecordRow | undefined => {
    if (tAppId === appId) {
      const r = records.find((x) => x.id === id);
      if (r) return r;
    }
    for (const [ref, rows] of Object.entries(blockRecords)) {
      if (parseBlock(ref, appId).appId === tAppId) {
        const r = rows.find((x) => x.id === id);
        if (r) return r;
      }
    }
    return undefined;
  };

  const editIn =
    (tAppId: string) =>
    async (r: RecordRow, fieldId: string, value: unknown) => {
      const data = { ...r.data, [fieldId]: value };
      patchSlices(tAppId, r.id, data); // optimistic; avoids snap-back
      try {
        await updateRecord(tAppId, r.id, data);
        await reload();
      } catch (e) {
        await reload(); // roll back to server state
        toast(`保存に失敗しました: ${e instanceof Error ? e.message : e}`, {
          type: "error",
        });
      }
    };

  const toggleIn =
    (tAppId: string) =>
    async (r: RecordRow, fieldId: string, checked: boolean) => {
      await editIn(tAppId)(r, fieldId, checked);
    };

  const deleteIn = (tAppId: string) => async (id: number) => {
    const doomed = findRecord(tAppId, id);
    try {
      await deleteRecord(tAppId, id);
      await reload();
      toast("レコードを削除しました", {
        action: doomed
          ? {
              label: "取り消す",
              onClick: async () => {
                await createRecord(tAppId, doomed.data);
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

  // Build the callback bundle a view needs, bound to the app it displays.
  const handlersFor = (tApp: AppDefinition): ViewHandlers => ({
    onOpen: (r) => setEditing({ app: tApp, record: r }),
    onToggle: toggleIn(tApp.id),
    onCreate: () => setEditing({ app: tApp, record: null }),
    onDelete: deleteIn(tApp.id),
    onMove: editIn(tApp.id),
    onEdit: editIn(tApp.id),
  });

  // The record modal saves/deletes against whichever app it's editing.
  const onSave = async (data: Record<string, unknown>, id?: number) => {
    const tAppId = editing?.app.id ?? appId;
    try {
      if (id != null) await updateRecord(tAppId, id, data);
      else await createRecord(tAppId, data);
      await reload();
      toast(id != null ? "保存しました" : "追加しました", { type: "success" });
    } catch (e) {
      toast(`保存に失敗しました: ${e instanceof Error ? e.message : e}`, {
        type: "error",
      });
      throw e; // keep the modal open
    }
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
            onClick={() => setEditing({ app: def, record: null })}
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
        ) : view?.type === "page" ? (
          <PageView
            app={def}
            view={view}
            foreignDefs={foreignDefs}
            recordsByRef={blockRecords}
            handlersFor={handlersFor}
          />
        ) : (
          <ViewBody
            app={def}
            view={view!}
            records={records}
            handlers={handlersFor(def)}
          />
        )}
      </div>

      {editing !== undefined && (
        // A foreign record needs its own app's relation context; wrap only then
        // (local records already sit under the outer provider).
        editing.app.id === def.id ? (
          <RecordModal
            app={editing.app}
            record={editing.record}
            onSave={onSave}
            onDelete={deleteIn(editing.app.id)}
            onClose={() => setEditing(undefined)}
          />
        ) : (
          <RelationProvider app={editing.app}>
            <RecordModal
              app={editing.app}
              record={editing.record}
              onSave={onSave}
              onDelete={deleteIn(editing.app.id)}
              onClose={() => setEditing(undefined)}
            />
          </RelationProvider>
        )
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
