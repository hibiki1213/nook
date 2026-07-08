// Read-only rendering of a field value in a table cell or board card.
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import { Chip } from "./primitives";
import { FileIcon, LinkIcon } from "./icons";
import { useRelations } from "./relations";
import { formatMoney, toTags } from "../lib/format";
import { fileAbsPath, toFileRefs } from "../lib/files";
import { resolveImageSrc } from "../lib/images";
import type { Field } from "../types";

function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

/** Stars display (☆ up to max, ★ up to the value). */
function StarsValue({ value, max }: { value: number; max: number }) {
  return (
    <span className="nk-stars" aria-label={`${value}/${max}`}>
      {Array.from({ length: max }, (_, i) => (
        <span key={i} className={i < value ? "nk-star is-on" : "nk-star"}>
          {i < value ? "★" : "☆"}
        </span>
      ))}
    </span>
  );
}

export function FieldValue({ field, value }: { field: Field; value: unknown }) {
  // Hook must run unconditionally; it's cheap (context read).
  const { titleOf } = useRelations();
  // `tags` renders its own empty state (an empty array is still "no value").
  if (
    field.type !== "tags" &&
    (value === null || value === undefined || value === "")
  ) {
    return <span className="nk-empty">—</span>;
  }
  switch (field.type) {
    case "relation": {
      const title = titleOf(field.app, value);
      return (
        <span className="nk-relation" title={title ?? undefined}>
          <LinkIcon size={12} className="nk-relation-icon" />
          {title ?? `#${String(value)}`}
        </span>
      );
    }
    case "select":
      return <Chip value={String(value)} options={field.options} />;
    case "checkbox":
      return value ? (
        <span className="nk-check">✓</span>
      ) : (
        <span className="nk-empty">—</span>
      );
    case "number":
      return <span className="nk-num">{String(value)}</span>;
    case "money":
      return <span className="nk-num">{formatMoney(value, field.currency)}</span>;
    case "rating":
      return (
        <StarsValue
          value={typeof value === "number" ? value : 0}
          max={field.max ?? 5}
        />
      );
    case "tags": {
      const tags = toTags(value);
      if (!tags.length) return <span className="nk-empty">—</span>;
      return (
        <span className="nk-tags">
          {tags.map((t) => (
            <Chip key={t} value={t} options={field.options} />
          ))}
        </span>
      );
    }
    case "url": {
      const href = String(value);
      return (
        <a
          className="nk-link"
          href={href}
          onClick={(e) => {
            // Don't let the webview navigate or the row-click fire; open the
            // link in the user's real browser instead.
            e.preventDefault();
            e.stopPropagation();
            void openUrl(href);
          }}
        >
          {truncate(href.replace(/^https?:\/\//, ""), 40)}
        </a>
      );
    }
    case "image":
      return (
        <img
          className="nk-image-thumb"
          src={resolveImageSrc(String(value))}
          alt=""
          loading="lazy"
          onError={(e) => {
            (e.currentTarget as HTMLImageElement).style.display = "none";
          }}
        />
      );
    case "file": {
      const files = toFileRefs(value);
      if (!files.length) return <span className="nk-empty">—</span>;
      const [first] = files;
      return (
        <span className="nk-files">
          <button
            type="button"
            className="nk-file-chip"
            title={first.name}
            onClick={(e) => {
              // Don't let the row-click open the record modal; open the file.
              e.preventDefault();
              e.stopPropagation();
              const path = fileAbsPath(first.ref);
              if (path) void openPath(path);
            }}
          >
            <FileIcon size={12} />
            {truncate(first.name, 24)}
          </button>
          {files.length > 1 && (
            <span className="nk-file-more" title={files.slice(1).map((f) => f.name).join("\n")}>
              +{files.length - 1}
            </span>
          )}
        </span>
      );
    }
    case "textarea":
      return <span className="nk-muted">{truncate(String(value), 60)}</span>;
    case "date":
    case "text":
    default:
      return <span>{String(value)}</span>;
  }
}
