// The sidebar's "＋新規アプリ" now forks: build one yourself, or paste an
// invite ticket and join someone else's. (Claude Desktop remains the third,
// conversational way in — mentioned as a hint, not a button, since it lives
// outside this window.)
import { Modal } from "./primitives";
import { PlusIcon, ShareIcon } from "./icons";

export function AddAppModal({
  onCreate,
  onJoin,
  onClose,
}: {
  onCreate: () => void;
  onJoin: () => void;
  onClose: () => void;
}) {
  return (
    <Modal open onClose={onClose} title="アプリを追加">
      <div className="nk-add-choices">
        <button type="button" className="nk-add-choice" onClick={onCreate}>
          <span className="nk-add-choice-icon">
            <PlusIcon size={18} />
          </span>
          <span className="nk-add-choice-body">
            <span className="nk-add-choice-title">手動で作成</span>
            <span className="nk-add-choice-desc">
              名前を付けて、フィールドやビューを自分で組み立てる
            </span>
          </span>
        </button>
        <button type="button" className="nk-add-choice" onClick={onJoin}>
          <span className="nk-add-choice-icon">
            <ShareIcon size={18} />
          </span>
          <span className="nk-add-choice-body">
            <span className="nk-add-choice-title">チケットで参加</span>
            <span className="nk-add-choice-desc">
              受け取った招待チケット(nook1…)を貼り付けて、共有アプリに参加する
            </span>
          </span>
        </button>
        <div className="nk-hint">
          もうひとつの方法: <b>Claude Desktop</b> に「◯◯アプリを作って」と頼む
        </div>
      </div>
    </Modal>
  );
}
