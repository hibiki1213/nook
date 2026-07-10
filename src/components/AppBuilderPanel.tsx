// The app builder: manual schema editing for an app (Claude does the same
// thing over MCP with create_app/add_field). Right-docked panel; every change
// applies immediately via update_app — no draft/save step. Field ids are
// deliberately never shown: they're auto-numbered (field_1, …) and immutable,
// so "rename" is always just a label change.
import { useEffect, useRef, useState } from "react";
import { Button, Checkbox, Input } from "@emobi/ui";
import { getApp, listApps, updateApp } from "../api";
import type {
  AppDefinition,
  AppSummary,
  Field,
  FieldType,
  View,
} from "../types";
import { Modal, TagInput } from "./primitives";
import { PlusIcon, TrashIcon } from "./icons";
import { useToast } from "./Toast";

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
  const toast = useToast();

  // Relation targets. Fetched here so the builder stays self-contained.
  useEffect(() => {
    void listApps().then(setApps);
  }, []);

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
    mutate({ ...def, views: def.views.filter((v) => v.id !== id) });
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
          {def.views.map((v) => (
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
                    <Row label="表示列">
                      <div className="nk-builder-cols">
                        {def.fields.map((f) => {
                          // Empty columns = show everything.
                          const shown =
                            !v.columns?.length || v.columns.includes(f.id);
                          return (
                            <Checkbox
                              key={f.id}
                              checked={shown}
                              label={f.label}
                              onChange={(on) => {
                                const all = def.fields.map((x) => x.id);
                                const cur = v.columns?.length ? v.columns : all;
                                const next = on
                                  ? all.filter(
                                      (id) => cur.includes(id) || id === f.id,
                                    )
                                  : cur.filter((id) => id !== f.id);
                                patchView(v.id, {
                                  columns: next.length === all.length ? [] : next,
                                });
                              }}
                            />
                          );
                        })}
                      </div>
                    </Row>
                  )}
                  {def.views.length > 1 && (
                    <div className="nk-fieldrow-foot">
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
