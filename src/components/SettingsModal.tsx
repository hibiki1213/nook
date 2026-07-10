import { useTheme } from "@emobi/ui";
import { Modal } from "./primitives";
import { AccentPicker } from "./AccentPicker";
import { SunIcon, MoonIcon, MonitorIcon } from "./icons";

const THEMES = [
  { value: "light" as const, label: "ライト", Icon: SunIcon },
  { value: "dark" as const, label: "ダーク", Icon: MoonIcon },
  { value: "system" as const, label: "自動", Icon: MonitorIcon },
];

// App settings. Sections are meant to grow — keep each one a label + control
// row so new settings slot in without layout surgery.
export function SettingsModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { theme, setTheme } = useTheme();
  return (
    <Modal open={open} onClose={onClose} title="設定">
      <div className="nk-settings">
        <section className="nk-settings-section">
          <div className="nk-settings-label">テーマ</div>
          <div className="nk-settings-seg" role="group" aria-label="テーマ">
            {THEMES.map(({ value, label, Icon }) => (
              <button
                key={value}
                type="button"
                className={`nk-settings-seg-opt${
                  theme === value ? " is-active" : ""
                }`}
                aria-pressed={theme === value}
                onClick={() => setTheme(value)}
              >
                <Icon size={14} />
                {label}
              </button>
            ))}
          </div>
        </section>
        <section className="nk-settings-section">
          <div className="nk-settings-label">アクセントカラー</div>
          <AccentPicker />
        </section>
      </div>
    </Modal>
  );
}
