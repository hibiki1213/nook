// The app builder: manual schema editing for an app (Claude does the same
// thing over MCP with create_app/add_field). Right-docked panel; every change
// applies immediately via update_app — no draft/save step. Field ids are
// deliberately never shown: they're auto-numbered (field_1, …) and immutable,
// so "rename" is always just a label change.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button, Checkbox, Input } from "@emobi/ui";
import { getApp, listApps, updateApp } from "../api";
import type {
  AppDefinition,
  AppSummary,
  Field,
  FieldType,
  SortSpec,
  View,
} from "../types";
import { Modal, TagInput } from "./primitives";
import { PlusIcon, TrashIcon } from "./icons";
import { useToast } from "./Toast";
import { makeBlock, parseBlock } from "../lib/blocks";

export const FIELD_TYPES: { value: FieldType; label: string }[] = [
  { value: "text", label: "テキスト" },
  { value: "textarea", label: "長文テキスト" },
  { value: "number", label: "数値" },
  { value: "checkbox", label: "チェックボックス" },
  { value: "select", label: "セレクト" },
  { value: "date", label: "日付" },
  { value: "url", label: "URL" },
  { value: "money", label: "金額" },
  { value: "rating", label: "評価（星）" },
  { value: "tags", label: "タグ" },
  { value: "image", label: "画像" },
  { value: "file", label: "ファイル" },
  { value: "relation", label: "リレーション" },
];

const VIEW_TYPES: { value: NonNullable<View["type"]>; label: string }[] = [
  { value: "table", label: "テーブル" },
  { value: "board", label: "ボード" },
  { value: "calendar", label: "カレンダー" },
  { value: "gallery", label: "ギャラリー" },
  { value: "summary", label: "集計" },
  { value: "chart", label: "チャート" },
  { value: "heatmap", label: "ヒートマップ" },
  { value: "page", label: "ページ（複数ビュー）" },
];

const typeLabel = (t: FieldType) =>
  FIELD_TYPES.find((x) => x.value === t)?.label ?? t;

/** Smallest `prefix<n>` not yet taken (ids are hidden, so pretty is moot). */
export function nextId(prefix: string, taken: string[]): string {
  let n = 1;
  while (taken.includes(`${prefix}${n}`)) n += 1;
  return `${prefix}${n}`;
}

/** A labelled control row inside the builder. */
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="nk-builder-row">
      <span className="nk-builder-rowlabel">{label}</span>
      <div className="nk-builder-rowctl">{children}</div>
    </div>
  );
}

/** Native select with value/label pairs, styled like primitives' Select. */
function PickRow({
  label,
  value,
  onChange,
  options,
  placeholder = "選択…",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  placeholder?: string;
}) {
  return (
    <Row label={label}>
      <div className="nk-select">
        <select value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="" disabled hidden>
            {placeholder}
          </option>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <svg
          className="nk-select-chevron"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </div>
    </Row>
  );
}

/** Generic reorderable row list (drag the ⠿ grip, or the ↑/↓ buttons).
 *  Pointer-based, NOT HTML5 drag & drop — the Tauri webview's native drag
 *  handler swallows HTML5 drag events (see BoardView for the same story). */
function ReorderList({
  items,
  onMove,
  onRemove,
  removeTitle,
  canRemove = true,
}: {
  items: { id: string; label: ReactNode }[];
  onMove: (from: number, to: number) => void;
  onRemove: (id: string) => void;
  removeTitle: string;
  canRemove?: boolean;
}) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);
  // Index of the row under the pointer, by row rects (rows don't move while
  // dragging — only the highlight does, so rects stay valid).
  const rowAt = (y: number) => {
    const rows = listRef.current?.querySelectorAll(".nk-blockrow") ?? [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i].getBoundingClientRect();
      if (y >= r.top && y <= r.bottom) return i;
    }
    return null;
  };
  return (
    <div className="nk-blocklist" ref={listRef}>
      {items.map(({ id, label }, i) => (
        <div
          key={id}
          className={`nk-blockrow${
            overIdx === i && dragIdx !== null && dragIdx !== i
              ? " is-drag-over"
              : ""
          }${dragIdx === i ? " is-dragging" : ""}`}
        >
          <span
            className="nk-blockrow-grip"
            aria-hidden
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              e.preventDefault(); // no text selection while dragging
              setDragIdx(i);
              e.currentTarget.setPointerCapture(e.pointerId);
            }}
            onPointerMove={(e) => {
              if (dragIdx === null) return;
              setOverIdx(rowAt(e.clientY));
            }}
            onPointerUp={() => {
              if (dragIdx !== null && overIdx !== null) {
                onMove(dragIdx, overIdx);
              }
              setDragIdx(null);
              setOverIdx(null);
            }}
            onPointerCancel={() => {
              setDragIdx(null);
              setOverIdx(null);
            }}
          >
            ⠿
          </span>
          <div className="nk-blockrow-name">{label}</div>
          <div className="nk-builder-reorder">
            <button
              type="button"
              disabled={i === 0}
              onClick={() => onMove(i, i - 1)}
              title="上へ"
            >
              ↑
            </button>
            <button
              type="button"
              disabled={i === items.length - 1}
              onClick={() => onMove(i, i + 1)}
              title="下へ"
            >
              ↓
            </button>
          </div>
          <button
            type="button"
            className="nk-blockrow-remove"
            title={removeTitle}
            disabled={!canRemove}
            onClick={() => onRemove(id)}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}

/** Reorder helper: move items[from] to position `to`. */
function moved<T>(items: T[], from: number, to: number): T[] {
  const next = [...items];
  const [x] = next.splice(from, 1);
  next.splice(to, 0, x);
  return next;
}

/** Block list editor for a `page` view: pick which views appear on the page
 *  (from this app OR another app) and in what vertical order. */
function PageBlocksEditor({
  view,
  localApp,
  foreignDefs,
  onChange,
}: {
  view: View;
  /** The app being edited (live definition). */
  localApp: AppDefinition;
  /** appId → definition for every OTHER app, to list their views. */
  foreignDefs: Record<string, AppDefinition>;
  onChange: (blocks: string[]) => void;
}) {
  const blocks = view.blocks ?? [];
  // Resolve a ref to a human label (view name, plus app for foreign refs).
  const labelOf = (ref: string) => {
    const { appId, viewId, foreign } = parseBlock(ref, localApp.id);
    const app = foreign ? foreignDefs[appId] : localApp;
    const v = app?.views.find((x) => x.id === viewId);
    if (!v) return foreign ? `${appId} / ${viewId}` : viewId; // dangling
    return foreign ? `${v.name} — ${app!.icon ?? "🗂"} ${app!.name}` : v.name;
  };
  // Candidate views to add, grouped: this app first, then each other app.
  const localOpts = localApp.views
    .filter((v) => v.type !== "page" && !blocks.includes(v.id))
    .map((v) => ({ value: v.id, label: v.name }));
  const foreignOpts = Object.values(foreignDefs).flatMap((app) =>
    app.views
      .filter((v) => v.type !== "page")
      .map((v) => ({ value: makeBlock(app.id, v.id, localApp.id), label: v }))
      .filter((o) => !blocks.includes(o.value))
      .map((o) => ({
        value: o.value,
        label: `${app.icon ?? "🗂"} ${app.name} / ${o.label.name}`,
      })),
  );
  const options = [...localOpts, ...foreignOpts];
  return (
    <>
      <Row label="ビュー構成">
        <div className="nk-blockstack">
          <ReorderList
            items={blocks.map((ref) => ({ id: ref, label: labelOf(ref) }))}
            onMove={(from, to) => onChange(moved(blocks, from, to))}
            onRemove={(id) => onChange(blocks.filter((b) => b !== id))}
            removeTitle="ページから外す"
          />
          {!blocks.length && (
            <p className="nk-builder-hint">
              下のセレクトからビューを追加すると、上から順に縦に並びます。
              他のアプリのビューも配置できます。
            </p>
          )}
        </div>
      </Row>
      {options.length > 0 && (
        <PickRow
          label="ビューを追加"
          value=""
          options={options}
          onChange={(ref) => onChange([...blocks, ref])}
        />
      )}
    </>
  );
}

/** Column editor for a table view: the view's columns as an ordered list
 *  (the table renders them in this order), with the remaining fields tucked
 *  behind a disclosure to keep the panel focused on what the view shows. */
function ColumnsEditor({
  view,
  fields,
  onChange,
}: {
  view: View;
  fields: Field[];
  onChange: (columns: string[]) => void;
}) {
  const [showHidden, setShowHidden] = useState(false);
  const all = fields.map((f) => f.id);
  // Empty columns = "all fields, definition order" (the stored shorthand).
  const shown = view.columns?.length
    ? view.columns.filter((id) => all.includes(id))
    : all;
  const hidden = fields.filter((f) => !shown.includes(f.id));
  const labelOf = (id: string) =>
    fields.find((f) => f.id === id)?.label ?? id;
  // Keep the shorthand when the explicit list round-trips to the default.
  const commit = (list: string[]) =>
    onChange(
      list.length === all.length && list.every((id, i) => id === all[i])
        ? []
        : list,
    );
  return (
    <Row label="表示列">
      <div className="nk-blockstack">
        <ReorderList
          items={shown.map((id) => ({ id, label: labelOf(id) }))}
          onMove={(from, to) => commit(moved(shown, from, to))}
          onRemove={(id) => commit(shown.filter((c) => c !== id))}
          removeTitle="列を隠す"
          canRemove={shown.length > 1}
        />
        {hidden.length > 0 && (
          <>
            <button
              type="button"
              className="nk-builder-toggle"
              onClick={() => setShowHidden((s) => !s)}
            >
              {showHidden ? "▴" : "▾"} 非表示の列（{hidden.length}）
            </button>
            {showHidden &&
              hidden.map((f) => (
                <button
                  type="button"
                  key={f.id}
                  className="nk-blockrow nk-blockrow-add"
                  title="列を表示"
                  onClick={() => commit([...shown, f.id])}
                >
                  <PlusIcon size={13} />
                  <span className="nk-blockrow-name">{f.label}</span>
                </button>
              ))}
          </>
        )}
      </div>
    </Row>
  );
}

/** Small chevron for the bare selects below (mirrors PickRow's). */
function SelectChevron() {
  return (
    <svg
      className="nk-select-chevron"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

/** Sort editor: an ordered list of {field, dir} keys (first = primary). Reorder
 *  the priority by dragging the grip, flip direction per key, add/remove keys.
 *  Applies to any list-like view; the backend builds ORDER BY from `view.sort`. */
function SortEditor({
  view,
  fields,
  onChange,
}: {
  view: View;
  fields: Field[];
  onChange: (sort: SortSpec[]) => void;
}) {
  const sort = view.sort ?? [];
  // image/file sort by an opaque ref — not meaningful, so keep them out.
  const sortable = fields.filter((f) => f.type !== "image" && f.type !== "file");
  const used = new Set(sort.map((s) => s.field));
  const candidates = sortable.filter((f) => !used.has(f.id));
  const setEntry = (i: number, patch: Partial<SortSpec>) =>
    onChange(sort.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  return (
    <>
      <Row label="並べ替え">
        <div className="nk-blockstack">
          <ReorderList
            items={sort.map((s, i) => ({
              id: s.field,
              label: (
                <div className="nk-sortrow">
                  <div className="nk-select nk-sortrow-field">
                    <select
                      value={s.field}
                      onChange={(e) => setEntry(i, { field: e.target.value })}
                    >
                      {sortable
                        .filter((f) => f.id === s.field || !used.has(f.id))
                        .map((f) => (
                          <option key={f.id} value={f.id}>
                            {f.label}
                          </option>
                        ))}
                    </select>
                    <SelectChevron />
                  </div>
                  <button
                    type="button"
                    className="nk-sortrow-dir"
                    title="昇順／降順を切り替え"
                    onClick={() =>
                      setEntry(i, {
                        dir: (s.dir ?? "asc") === "asc" ? "desc" : "asc",
                      })
                    }
                  >
                    {(s.dir ?? "asc") === "asc" ? "昇順 ↑" : "降順 ↓"}
                  </button>
                </div>
              ),
            }))}
            onMove={(from, to) => onChange(moved(sort, from, to))}
            onRemove={(id) => onChange(sort.filter((s) => s.field !== id))}
            removeTitle="この並べ替えを外す"
          />
          {!sort.length && (
            <p className="nk-builder-hint">
              未指定のときは新しい順です。フィールドを追加すると並べ替えます。
            </p>
          )}
        </div>
      </Row>
      {candidates.length > 0 && (
        <PickRow
          label="並べ替えを追加"
          value=""
          options={candidates.map((f) => ({ value: f.id, label: f.label }))}
          onChange={(field) => onChange([...sort, { field, dir: "asc" }])}
        />
      )}
    </>
  );
}

/** Strip references to a deleted field from every view. */
function stripFieldFromViews(views: View[], fieldId: string): View[] {
  return views.map((v) => ({
    ...v,
    columns: v.columns?.filter((c) => c !== fieldId),
    sort: v.sort?.filter((s) => s.field !== fieldId),
    groupBy: v.groupBy === fieldId ? undefined : v.groupBy,
    dateField: v.dateField === fieldId ? undefined : v.dateField,
    imageField: v.imageField === fieldId ? undefined : v.imageField,
    metric: v.metric?.field === fieldId ? { ...v.metric, field: undefined } : v.metric,
  }));
}

export function AppBuilderPanel({
  app,
  onUpdated,
  onClose,
}: {
  app: AppDefinition;
  /** Called with the saved definition after every successful apply. */
  onUpdated: (def: AppDefinition) => void;
  onClose: () => void;
}) {
  const [def, setDef] = useState<AppDefinition>(app);
  const [openField, setOpenField] = useState<string | null>(null);
  const [openView, setOpenView] = useState<string | null>(null);
  const [confirmField, setConfirmField] = useState<string | null>(null);
  const [apps, setApps] = useState<AppSummary[]>([]);
  // Full definitions of OTHER apps — only needed to offer their views to a
  // page's block list, so loaded lazily when this app has a page view.
  const [foreignDefs, setForeignDefs] = useState<Record<string, AppDefinition>>({});
  const toast = useToast();

  // Relation targets. Fetched here so the builder stays self-contained.
  useEffect(() => {
    void listApps().then(setApps);
  }, []);

  const hasPage = def.views.some((v) => v.type === "page");
  useEffect(() => {
    if (!hasPage) return;
    let alive = true;
    (async () => {
      const list = await listApps();
      const entries = await Promise.all(
        list
          .filter((a) => a.id !== app.id)
          .map((a) =>
            getApp(a.id)
              .then((d) => [a.id, d] as const)
              .catch(() => null),
          ),
      );
      if (alive) {
        setForeignDefs(
          Object.fromEntries(entries.filter(Boolean) as [string, AppDefinition][]),
        );
      }
    })();
    return () => {
      alive = false;
    };
  }, [hasPage, app.id]);

  // Immediate apply. Text edits debounce so we don't hit SQLite per keystroke;
  // structural edits (add/delete/type) go through right away. `latest` makes
  // the trailing debounce always send the newest draft.
  const latest = useRef(def);
  const timer = useRef<number | undefined>(undefined);
  const commit = async (next: AppDefinition) => {
    try {
      const saved = await updateApp(app.id, next);
      onUpdated(saved);
    } catch (e) {
      toast(`変更を保存できませんでした: ${e instanceof Error ? e.message : e}`, {
        type: "error",
      });
      // Resync with the backend's truth (e.g. Claude changed the app, or the
      // edit was invalid) so the panel doesn't drift.
      const fresh = await getApp(app.id);
      setDef(fresh);
      latest.current = fresh;
      onUpdated(fresh);
    }
  };
  const mutate = (next: AppDefinition, debounce = false) => {
    setDef(next);
    latest.current = next;
    window.clearTimeout(timer.current);
    if (debounce) {
      timer.current = window.setTimeout(() => void commit(latest.current), 500);
    } else {
      timer.current = undefined;
      void commit(next);
    }
  };
  // Flush a pending debounced edit when the panel closes.
  useEffect(
    () => () => {
      if (timer.current !== undefined) {
        window.clearTimeout(timer.current);
        void commit(latest.current);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const patchField = (id: string, patch: Partial<Field>, debounce = false) =>
    mutate(
      {
        ...def,
        fields: def.fields.map((f) => (f.id === id ? { ...f, ...patch } : f)),
      },
      debounce,
    );

  const setFieldType = (f: Field, type: FieldType) => {
    const patch: Partial<Field> = { type };
    // Cross-type constraints (mirrors Field::validate on the Rust side).
    if (type !== "date") patch.remind = false;
    if (type !== "file") patch.multiple = false;
    if (type === "relation") {
      const target = apps.find((a) => a.id !== def.id) ?? apps[0];
      if (!target) {
        toast("リレーション先にできるアプリがありません", { type: "error" });
        return;
      }
      patch.app = f.app ?? target.id;
    }
    patchField(f.id, patch);
  };

  const addField = () => {
    const id = nextId("field_", def.fields.map((f) => f.id));
    mutate({
      ...def,
      fields: [...def.fields, { id, label: "新しいフィールド", type: "text" }],
    });
    setOpenField(id);
  };

  const removeField = (id: string) => {
    setConfirmField(null);
    setOpenField(null);
    mutate({
      ...def,
      fields: def.fields.filter((f) => f.id !== id),
      views: stripFieldFromViews(def.views, id),
    });
  };

  const moveField = (id: string, dir: -1 | 1) => {
    const i = def.fields.findIndex((f) => f.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= def.fields.length) return;
    const fields = [...def.fields];
    [fields[i], fields[j]] = [fields[j], fields[i]];
    mutate({ ...def, fields });
  };

  const patchView = (id: string, patch: Partial<View>, debounce = false) =>
    mutate(
      {
        ...def,
        views: def.views.map((v) => (v.id === id ? { ...v, ...patch } : v)),
      },
      debounce,
    );

  // Reorder the view itself — this is the tab order, and views[0] is the app's
  // default view. Mirrors moveField.
  const moveView = (id: string, dir: -1 | 1) => {
    const i = def.views.findIndex((v) => v.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= def.views.length) return;
    const views = [...def.views];
    [views[i], views[j]] = [views[j], views[i]];
    mutate({ ...def, views });
  };

  const addView = () => {
    const id = nextId("view_", def.views.map((v) => v.id));
    mutate({
      ...def,
      views: [...def.views, { id, name: "新しいビュー", type: "table" }],
    });
    setOpenView(id);
  };

  const removeView = (id: string) => {
    if (def.views.length <= 1) return;
    setOpenView(null);
    mutate({
      ...def,
      // Also strip the view from any page that references it.
      views: def.views
        .filter((v) => v.id !== id)
        .map((v) =>
          v.blocks?.includes(id)
            ? { ...v, blocks: v.blocks.filter((b) => b !== id) }
            : v,
        ),
    });
  };

  // Field pickers per role, for view configuration.
  const fieldOpts = (types: FieldType[]) =>
    def.fields
      .filter((f) => types.includes(f.type))
      .map((f) => ({ value: f.id, label: f.label }));
  const numericOpts = fieldOpts(["number", "money", "rating"]);

  return (
    <Modal
      open
      variant="panel"
      onClose={onClose}
      title={
        <span>
          {def.icon ?? "🗂"} アプリを編集 — {def.name}
        </span>
      }
      footer={
        <>
          <span className="nk-builder-note">変更は即座に保存されます</span>
          <div style={{ flex: 1 }} />
          <Button variant="primary" onClick={onClose}>
            完了
          </Button>
        </>
      }
    >
      <div className="nk-builder">
        {/* ── 基本情報 ── */}
        <section className="nk-builder-section">
          <div className="nk-builder-heading">基本情報</div>
          <div className="nk-builder-basics">
            <Input
              className="nk-builder-icon"
              value={def.icon ?? ""}
              placeholder="🗂"
              aria-label="アイコン（絵文字）"
              onChange={(e) =>
                mutate({ ...def, icon: e.target.value || undefined }, true)
              }
            />
            <Input
              value={def.name}
              aria-label="アプリ名"
              onChange={(e) => mutate({ ...def, name: e.target.value }, true)}
            />
          </div>
        </section>

        {/* ── フィールド ── */}
        <section className="nk-builder-section">
          <div className="nk-builder-heading">
            フィールド
            <button type="button" className="nk-builder-add" onClick={addField}>
              <PlusIcon size={13} /> 追加
            </button>
          </div>
          {def.fields.map((f, i) => (
            <div
              key={f.id}
              className={`nk-fieldrow${openField === f.id ? " is-open" : ""}`}
            >
              <button
                type="button"
                className="nk-fieldrow-head"
                onClick={() =>
                  setOpenField(openField === f.id ? null : f.id)
                }
              >
                <span className="nk-fieldrow-name">{f.label}</span>
                <span className="nk-fieldrow-meta">
                  {typeLabel(f.type)}
                  {f.required ? "・必須" : ""}
                  {f.remind ? "・リマインド" : ""}
                </span>
                <span className="nk-fieldrow-chevron">
                  {openField === f.id ? "▴" : "▾"}
                </span>
              </button>
              {openField === f.id && (
                <div className="nk-fieldrow-body">
                  <Row label="ラベル">
                    <Input
                      value={f.label}
                      onChange={(e) =>
                        patchField(f.id, { label: e.target.value }, true)
                      }
                    />
                  </Row>
                  <PickRow
                    label="タイプ"
                    value={f.type}
                    options={FIELD_TYPES}
                    onChange={(t) => setFieldType(f, t as FieldType)}
                  />
                  {(f.type === "select" || f.type === "tags") && (
                    <Row label="選択肢">
                      <TagInput
                        value={f.options ?? []}
                        onChange={(options) => patchField(f.id, { options })}
                      />
                    </Row>
                  )}
                  {f.type === "rating" && (
                    <Row label="星の数">
                      <Input
                        type="number"
                        min={1}
                        max={10}
                        value={String(f.max ?? 5)}
                        onChange={(e) =>
                          patchField(
                            f.id,
                            { max: Math.max(1, Number(e.target.value) || 5) },
                            true,
                          )
                        }
                      />
                    </Row>
                  )}
                  {f.type === "money" && (
                    <Row label="通貨">
                      <Input
                        value={f.currency ?? "JPY"}
                        placeholder="JPY"
                        onChange={(e) =>
                          patchField(
                            f.id,
                            { currency: e.target.value.toUpperCase() },
                            true,
                          )
                        }
                      />
                    </Row>
                  )}
                  {f.type === "relation" && (
                    <PickRow
                      label="対象アプリ"
                      value={f.app ?? ""}
                      options={apps.map((a) => ({
                        value: a.id,
                        label: `${a.icon ?? "🗂"} ${a.name}`,
                      }))}
                      onChange={(appId) => patchField(f.id, { app: appId })}
                    />
                  )}
                  <div className="nk-builder-checks">
                    <Checkbox
                      checked={!!f.required}
                      onChange={(required) => patchField(f.id, { required })}
                      label="必須"
                    />
                    {f.type === "date" && (
                      <Checkbox
                        checked={!!f.remind}
                        onChange={(remind) => patchField(f.id, { remind })}
                        label="期日にリマインド"
                      />
                    )}
                    {f.type === "file" && (
                      <Checkbox
                        checked={!!f.multiple}
                        onChange={(multiple) => patchField(f.id, { multiple })}
                        label="複数添付"
                      />
                    )}
                  </div>
                  <div className="nk-fieldrow-foot">
                    <div className="nk-builder-reorder">
                      <button
                        type="button"
                        disabled={i === 0}
                        onClick={() => moveField(f.id, -1)}
                        title="上へ"
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        disabled={i === def.fields.length - 1}
                        onClick={() => moveField(f.id, 1)}
                        title="下へ"
                      >
                        ↓
                      </button>
                    </div>
                    <div style={{ flex: 1 }} />
                    {confirmField === f.id ? (
                      <>
                        <span className="nk-confirm-inline">削除しますか？</span>
                        <Button
                          size="sm"
                          variant="danger"
                          onClick={() => removeField(f.id)}
                        >
                          削除する
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setConfirmField(null)}
                        >
                          やめる
                        </Button>
                      </>
                    ) : (
                      <Button
                        size="sm"
                        variant="ghost"
                        leftIcon={<TrashIcon size={14} />}
                        onClick={() => setConfirmField(f.id)}
                      >
                        削除
                      </Button>
                    )}
                  </div>
                  {confirmField === f.id && (
                    <p className="nk-builder-hint">
                      値はレコード内に残るため、同じタイプで追加し直すと復元されます。
                    </p>
                  )}
                </div>
              )}
            </div>
          ))}
          {!def.fields.length && (
            <p className="nk-builder-hint">フィールドがありません。「追加」から作成してください。</p>
          )}
        </section>

        {/* ── ビュー ── */}
        <section className="nk-builder-section">
          <div className="nk-builder-heading">
            ビュー
            <button type="button" className="nk-builder-add" onClick={addView}>
              <PlusIcon size={13} /> 追加
            </button>
          </div>
          {def.views.map((v, vi) => (
            <div
              key={v.id}
              className={`nk-fieldrow${openView === v.id ? " is-open" : ""}`}
            >
              <button
                type="button"
                className="nk-fieldrow-head"
                onClick={() => setOpenView(openView === v.id ? null : v.id)}
              >
                <span className="nk-fieldrow-name">{v.name}</span>
                <span className="nk-fieldrow-meta">
                  {VIEW_TYPES.find((t) => t.value === (v.type ?? "table"))?.label}
                </span>
                <span className="nk-fieldrow-chevron">
                  {openView === v.id ? "▴" : "▾"}
                </span>
              </button>
              {openView === v.id && (
                <div className="nk-fieldrow-body">
                  <Row label="名前">
                    <Input
                      value={v.name}
                      onChange={(e) =>
                        patchView(v.id, { name: e.target.value }, true)
                      }
                    />
                  </Row>
                  <PickRow
                    label="タイプ"
                    value={v.type ?? "table"}
                    options={VIEW_TYPES}
                    onChange={(t) =>
                      patchView(v.id, { type: t as View["type"] })
                    }
                  />
                  {v.type === "page" && (
                    <PageBlocksEditor
                      view={v}
                      localApp={def}
                      foreignDefs={foreignDefs}
                      onChange={(blocks) => patchView(v.id, { blocks })}
                    />
                  )}
                  {(v.type === "board" ||
                    v.type === "summary") && (
                    <PickRow
                      label="グループ化"
                      value={v.groupBy ?? ""}
                      options={fieldOpts(["select"])}
                      placeholder="セレクトフィールド…"
                      onChange={(groupBy) => patchView(v.id, { groupBy })}
                    />
                  )}
                  {(v.type === "calendar" ||
                    v.type === "chart" ||
                    v.type === "heatmap") && (
                    <PickRow
                      label="日付フィールド"
                      value={v.dateField ?? ""}
                      options={fieldOpts(["date"])}
                      placeholder="日付フィールド…"
                      onChange={(dateField) => patchView(v.id, { dateField })}
                    />
                  )}
                  {v.type === "gallery" && (
                    <PickRow
                      label="画像フィールド"
                      value={v.imageField ?? ""}
                      options={fieldOpts(["image"])}
                      placeholder="画像フィールド…"
                      onChange={(imageField) => patchView(v.id, { imageField })}
                    />
                  )}
                  {(v.type === "summary" ||
                    v.type === "chart" ||
                    v.type === "heatmap") && (
                    <>
                      <PickRow
                        label="集計"
                        value={v.metric?.fn ?? "count"}
                        options={[
                          { value: "count", label: "件数" },
                          { value: "sum", label: "合計" },
                          { value: "avg", label: "平均" },
                          { value: "min", label: "最小" },
                          { value: "max", label: "最大" },
                        ]}
                        onChange={(fn) =>
                          patchView(v.id, {
                            metric: { ...v.metric, fn: fn as never },
                          })
                        }
                      />
                      {(v.metric?.fn ?? "count") !== "count" && (
                        <PickRow
                          label="対象フィールド"
                          value={v.metric?.field ?? ""}
                          options={numericOpts}
                          placeholder="数値系フィールド…"
                          onChange={(field) =>
                            patchView(v.id, {
                              metric: { ...v.metric, field },
                            })
                          }
                        />
                      )}
                    </>
                  )}
                  {v.type === "chart" && (
                    <>
                      <PickRow
                        label="スタイル"
                        value={v.chartType ?? "line"}
                        options={[
                          { value: "line", label: "折れ線" },
                          { value: "area", label: "エリア" },
                        ]}
                        onChange={(chartType) =>
                          patchView(v.id, { chartType: chartType as never })
                        }
                      />
                      <PickRow
                        label="単位"
                        value={v.bucket ?? "day"}
                        options={[
                          { value: "day", label: "日" },
                          { value: "week", label: "週" },
                          { value: "month", label: "月" },
                        ]}
                        onChange={(bucket) =>
                          patchView(v.id, { bucket: bucket as never })
                        }
                      />
                    </>
                  )}
                  {(v.type ?? "table") === "table" && def.fields.length > 0 && (
                    <ColumnsEditor
                      view={v}
                      fields={def.fields}
                      onChange={(columns) => patchView(v.id, { columns })}
                    />
                  )}
                  {/* Record order matters for list-like views. */}
                  {["table", "board", "gallery"].includes(v.type ?? "table") &&
                    def.fields.length > 0 && (
                      <SortEditor
                        view={v}
                        fields={def.fields}
                        onChange={(sort) => patchView(v.id, { sort })}
                      />
                    )}
                  {def.views.length > 1 && (
                    <div className="nk-fieldrow-foot">
                      {/* Reorder the view — sets the tab order; the first view
                          is the app's default. */}
                      <div className="nk-builder-reorder">
                        <button
                          type="button"
                          disabled={vi === 0}
                          onClick={() => moveView(v.id, -1)}
                          title="前へ"
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          disabled={vi === def.views.length - 1}
                          onClick={() => moveView(v.id, 1)}
                          title="後ろへ"
                        >
                          ↓
                        </button>
                      </div>
                      <div style={{ flex: 1 }} />
                      <Button
                        size="sm"
                        variant="ghost"
                        leftIcon={<TrashIcon size={14} />}
                        onClick={() => removeView(v.id)}
                      >
                        削除
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </section>
      </div>
    </Modal>
  );
}
