import { Card } from "@emobi/ui";
import { FieldValue } from "./FieldValue";
import { resolveImageSrc } from "../lib/images";
import type { AppDefinition, Field, RecordRow, View } from "../types";

/** Card grid keyed off an image field — good for collections (books, recipes…). */
export function GalleryView({
  app,
  view,
  records,
  onOpen,
}: {
  app: AppDefinition;
  view: View;
  records: RecordRow[];
  onOpen: (r: RecordRow) => void;
}) {
  const imageField =
    app.fields.find((f) => f.id === view.imageField) ??
    app.fields.find((f) => f.type === "image");
  const titleField =
    app.fields.find((f) => f.type === "text") ?? app.fields[0];
  // A couple of secondary fields on each card (skip the image + title).
  const metaFields: Field[] = app.fields
    .filter(
      (f) =>
        f.id !== imageField?.id &&
        f.id !== titleField?.id &&
        f.type !== "textarea",
    )
    .slice(0, 3);

  if (!records.length) {
    return (
      <div className="nk-empty-state">
        まだレコードがありません。「＋ 新規」から追加するか、Claude に頼んでみてください。
      </div>
    );
  }

  return (
    <div className="nk-gallery">
      {records.map((r) => {
        const src = imageField ? r.data[imageField.id] : undefined;
        return (
          <Card key={r.id} shadow className="nk-gallery-card">
            <button className="nk-gallery-hit" onClick={() => onOpen(r)}>
              <div className="nk-gallery-media">
                {src ? (
                  <img
                    src={resolveImageSrc(String(src))}
                    alt=""
                    loading="lazy"
                    onError={(e) => {
                      (e.currentTarget as HTMLImageElement).style.visibility =
                        "hidden";
                    }}
                  />
                ) : (
                  <span className="nk-gallery-noimg">🖼</span>
                )}
              </div>
              <div className="nk-gallery-body">
                <div className="nk-gallery-title">
                  {titleField
                    ? String(r.data[titleField.id] ?? "無題")
                    : "無題"}
                </div>
                <div className="nk-gallery-meta">
                  {metaFields.map((f) => (
                    <FieldValue key={f.id} field={f} value={r.data[f.id]} />
                  ))}
                </div>
              </div>
            </button>
          </Card>
        );
      })}
    </div>
  );
}
