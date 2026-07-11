import type { AppDefinition, RecordRow, View } from "../types";
import { parseBlock } from "../lib/blocks";
import { RelationProvider } from "./relations";
import { ViewBody, type ViewHandlers } from "./ViewBody";

/** A page stacks other views vertically in `view.blocks` order. A block can
 *  reference a view in ANOTHER app; that view then renders against its own app
 *  definition, records and relation context. */
export function PageView({
  app,
  view,
  foreignDefs,
  recordsByRef,
  handlersFor,
}: {
  app: AppDefinition;
  view: View;
  /** appId → definition, for the foreign apps this page references. */
  foreignDefs: Record<string, AppDefinition>;
  /** block ref string → records loaded with that view's sort. */
  recordsByRef: Record<string, RecordRow[]>;
  /** Build the handler bundle bound to the app a block displays. */
  handlersFor: (targetApp: AppDefinition) => ViewHandlers;
}) {
  const blocks = (view.blocks ?? []).map((ref) => {
    const { appId, viewId, foreign } = parseBlock(ref, app.id);
    const blockApp = foreign ? foreignDefs[appId] : app;
    const blockView = blockApp?.views.find((v) => v.id === viewId);
    return { ref, foreign, blockApp, blockView };
  });

  // Something to show if every block is missing (all deleted / still loading).
  const anyResolvable = blocks.some(
    (b) => b.blockApp && b.blockView && b.blockView.type !== "page",
  );
  if (!blocks.length) {
    return (
      <div className="nk-empty-state">
        このページにはまだビューがありません。「アプリを編集」からビューを配置してください。
      </div>
    );
  }

  return (
    <div className="nk-page">
      {blocks.map(({ ref, foreign, blockApp, blockView }) => {
        // A foreign app still loading: show a slim placeholder, not a crash.
        if (foreign && !blockApp) {
          return (
            <section className="nk-page-block" key={ref}>
              <div className="nk-page-block-body nk-page-block-missing">
                読み込み中…
              </div>
            </section>
          );
        }
        // Dangling ref (deleted view/app) or a nested page — skip quietly.
        if (!blockApp || !blockView || blockView.type === "page") return null;

        const body = (
          <ViewBody
            app={blockApp}
            view={blockView}
            records={recordsByRef[ref] ?? []}
            handlers={handlersFor(blockApp)}
          />
        );
        return (
          <section className="nk-page-block" key={ref}>
            <h3 className="nk-page-block-head">
              {blockView.name}
              {foreign && (
                <span className="nk-page-block-app">
                  {blockApp.icon ?? "🗂"} {blockApp.name}
                </span>
              )}
            </h3>
            <div className="nk-page-block-body">
              {/* Foreign blocks need their own app's relation context; local
                  blocks inherit the page app's provider from AppView. */}
              {foreign ? (
                <RelationProvider app={blockApp}>{body}</RelationProvider>
              ) : (
                body
              )}
            </div>
          </section>
        );
      })}
      {!anyResolvable && (
        <div className="nk-empty-state">
          配置されたビューが見つかりません。削除された可能性があります。
        </div>
      )}
    </div>
  );
}
