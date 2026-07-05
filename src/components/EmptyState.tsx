import { Button } from "@emobi/ui";
import { PlusIcon } from "./icons";

// HIG: an empty view should orient the user and offer the next action, not just
// say "nothing here". Doubles as a teaching moment for Nook's Claude workflow.
export function EmptyState({ onCreate }: { onCreate?: () => void }) {
  return (
    <div className="nk-empty-state">
      <div className="nk-empty-card">
        <div className="nk-empty-title">まだレコードがありません</div>
        <div className="nk-empty-desc">
          最初のレコードを追加するか、Claude Desktop に頼んでみましょう。
        </div>
        {onCreate && (
          <Button
            variant="primary"
            leftIcon={<PlusIcon size={16} />}
            onClick={onCreate}
          >
            新規レコード
          </Button>
        )}
        <div className="nk-empty-hint">
          例：「今日の支出を3件追加して」
        </div>
      </div>
    </div>
  );
}
