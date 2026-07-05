import { useEffect, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { importImage } from "../api";
import { resolveImageSrc } from "../lib/images";

const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "heic"];

/**
 * Dropzone + native file picker for `image` fields. Click opens the OS dialog;
 * dropping a file works through Tauri's webview drag-drop events (the webview
 * swallows HTML5 file drops, and only the Tauri event carries real paths).
 * A URL can still be pasted below — Claude (via MCP) always writes URLs.
 */
export function ImagePicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string | null) => void;
}) {
  const zoneRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const importPath = async (path: string) => {
    setBusy(true);
    setError(null);
    try {
      onChange(await importImage(path));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const pick = async () => {
    const picked = await openDialog({
      multiple: false,
      filters: [{ name: "画像", extensions: IMAGE_EXTENSIONS }],
    });
    if (typeof picked === "string") await importPath(picked);
  };

  // Tauri drag-drop: window-level events with physical positions — accept the
  // drop only when the cursor is over this dropzone.
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
        if (overZone(event.payload.position) && event.payload.paths[0]) {
          void importPath(event.payload.paths[0]);
        }
      } else {
        setDragging(false);
      }
    });
    return () => {
      void unlisten.then((f) => f());
    };
  }, []);

  const src = value ? resolveImageSrc(value) : "";

  return (
    <div className="nk-imagepicker">
      <div
        ref={zoneRef}
        className={`nk-dropzone${dragging ? " is-dragging" : ""}${busy ? " is-busy" : ""}`}
        role="button"
        tabIndex={0}
        onClick={pick}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && pick()}
      >
        {src ? (
          <img
            className="nk-dropzone-preview"
            src={src}
            alt=""
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).style.display = "none";
            }}
          />
        ) : (
          <div className="nk-dropzone-hint">
            <span className="nk-dropzone-icon">🖼</span>
            {busy ? "取り込み中…" : "クリックして選択、またはここにドラッグ"}
          </div>
        )}
        {src && (
          <div className="nk-dropzone-overlay">クリックで変更 / ドラッグで差し替え</div>
        )}
      </div>

      <div className="nk-imagepicker-row">
        <input
          className="nk-taginput-field nk-imagepicker-url"
          type="text"
          placeholder="または画像URLを貼り付け（https://… / data:…）"
          value={value.startsWith("nook-img://") ? "" : value}
          onChange={(e) => onChange(e.target.value)}
        />
        {value && (
          <button
            type="button"
            className="nk-imagepicker-clear"
            onClick={() => onChange(null)}
          >
            クリア
          </button>
        )}
      </div>
      {error && <div className="nk-imagepicker-error">{error}</div>}
    </div>
  );
}
