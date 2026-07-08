import { useEffect, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { importFile } from "../api";
import {
  fileAbsPath,
  formatSize,
  isEmbeddable,
  isImage,
  isPdf,
  resolveFileSrc,
  resolveThumbSrc,
  toFileRefs,
} from "../lib/files";
import type { Field, FileRef } from "../types";
import { FileIcon, TrashIcon } from "./icons";

// Mirrors ALLOWED_EXT in `src-tauri/src/files.rs` — only offer what the backend
// will accept, so the picker can't produce an error the user didn't ask for.
const ACCEPTED_EXTENSIONS = [
  "pdf", "txt", "md", "csv", "rtf", "json",
  "doc", "docx", "xls", "xlsx", "ppt", "pptx", "pages", "numbers", "key",
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "heic", "svg",
  "zip",
];

/**
 * Attachment control for `file` fields. Click or drop to add; `field.multiple`
 * makes the stored value an array. Embeddable files expand inline — PDFs render
 * through WKWebView's native viewer, which is why no PDF library is needed —
 * and everything else opens in its native app.
 *
 * Removing an attachment only drops the reference: the bytes stay in the files
 * dir, matching `images`' deliberate no-GC policy.
 */
export function FilePicker({
  field,
  value,
  onChange,
}: {
  field: Field;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const multiple = !!field.multiple;
  const refs = toFileRefs(value);

  const zoneRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [brokenThumbs, setBrokenThumbs] = useState<string[]>([]);

  // The drag-drop listener is registered once, so it must not close over a stale
  // `refs`. Everything it needs is read from here at call time.
  const latest = useRef({ refs, multiple });
  latest.current = { refs, multiple };

  const commit = (next: FileRef[]) =>
    onChange(latest.current.multiple ? next : (next[0] ?? null));

  const importPaths = async (paths: string[]) => {
    if (!paths.length) return;
    setBusy(true);
    setError(null);
    try {
      const { refs: current, multiple: many } = latest.current;
      const picked = many ? paths : paths.slice(0, 1);
      const imported: FileRef[] = [];
      // Sequential: each import copies bytes and shells out to qlmanage.
      for (const path of picked) imported.push(await importFile(path));
      commit(many ? [...current, ...imported] : imported);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const pick = async () => {
    const picked = await openDialog({
      multiple,
      filters: [{ name: "ファイル", extensions: ACCEPTED_EXTENSIONS }],
    });
    if (picked == null) return;
    await importPaths(Array.isArray(picked) ? picked : [picked]);
  };

  // Tauri drag-drop: window-level events with physical positions — accept the
  // drop only when the cursor is over this dropzone (same trick as ImagePicker).
  useEffect(() => {
    const overZone = (pos: { x: number; y: number }) => {
      const el = zoneRef.current;
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const scale = window.devicePixelRatio || 1;
      const x = pos.x / scale;
      const y = pos.y / scale;
      return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    };

    const unlisten = getCurrentWebview().onDragDropEvent((event) => {
      const t = event.payload.type;
      if (t === "over") {
        setDragging(overZone(event.payload.position));
      } else if (t === "drop") {
        setDragging(false);
        if (overZone(event.payload.position) && event.payload.paths.length) {
          void importPaths(event.payload.paths);
        }
      } else {
        setDragging(false);
      }
    });
    return () => {
      void unlisten.then((f) => f());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openNative = async (r: FileRef) => {
    const path = fileAbsPath(r.ref);
    if (path) await openPath(path);
  };

  /** Embeddable files toggle inline; the rest go straight to their native app. */
  const activate = (r: FileRef) => {
    if (isEmbeddable(r.name)) setExpanded(expanded === r.ref ? null : r.ref);
    else void openNative(r);
  };

  const remove = (r: FileRef) => {
    if (expanded === r.ref) setExpanded(null);
    commit(latest.current.refs.filter((x) => x.ref !== r.ref));
  };

  const markBroken = (ref: string) =>
    setBrokenThumbs((s) => (s.includes(ref) ? s : [...s, ref]));

  return (
    <div className="nk-filepicker">
      <div
        ref={zoneRef}
        className={`nk-dropzone nk-file-dropzone${dragging ? " is-dragging" : ""}${
          busy ? " is-busy" : ""
        }`}
        role="button"
        tabIndex={0}
        onClick={pick}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && pick()}
      >
        <div className="nk-dropzone-hint">
          <span className="nk-dropzone-icon">
            <FileIcon size={22} />
          </span>
          {busy
            ? "取り込み中…"
            : multiple
              ? "クリックして選択、またはここにドラッグ（複数可）"
              : "クリックして選択、またはここにドラッグ"}
        </div>
      </div>

      {refs.length > 0 && (
        <ul className="nk-file-list">
          {refs.map((r) => {
            const isOpen = expanded === r.ref;
            return (
              <li key={r.ref} className="nk-file-item">
                <div className="nk-file-row">
                  <span className="nk-file-thumb">
                    {brokenThumbs.includes(r.ref) ? (
                      <FileIcon size={18} />
                    ) : (
                      <img
                        src={resolveThumbSrc(r.ref)}
                        alt=""
                        onError={() => markBroken(r.ref)}
                      />
                    )}
                  </span>
                  <button
                    type="button"
                    className="nk-file-name"
                    onClick={() => activate(r)}
                    title={
                      isEmbeddable(r.name)
                        ? `${r.name} — クリックでプレビュー`
                        : `${r.name} — クリックで開く`
                    }
                  >
                    {r.name}
                  </button>
                  <span className="nk-file-size">{formatSize(r.size)}</span>
                  <button
                    type="button"
                    className="nk-file-btn"
                    onClick={() => void openNative(r)}
                  >
                    開く
                  </button>
                  <button
                    type="button"
                    className="nk-file-btn is-danger"
                    onClick={() => remove(r)}
                    aria-label={`${r.name} を外す`}
                  >
                    <TrashIcon size={14} />
                  </button>
                </div>

                {isOpen && (
                  <div className="nk-file-preview">
                    {isPdf(r.name) ? (
                      <iframe
                        className="nk-file-pdf"
                        src={resolveFileSrc(r.ref)}
                        title={r.name}
                      />
                    ) : isImage(r.name) ? (
                      <img
                        className="nk-file-img"
                        src={resolveFileSrc(r.ref)}
                        alt={r.name}
                      />
                    ) : null}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {error && <div className="nk-filepicker-error">{error}</div>}
    </div>
  );
}
