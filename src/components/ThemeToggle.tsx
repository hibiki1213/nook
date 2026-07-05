import { useTheme } from "@emobi/ui";
import { SunIcon, MoonIcon, MonitorIcon } from "./icons";

// Light / Dark / System — a compact segmented control in the sidebar foot.
// Respects the OS setting by default (System); the choice persists via the
// design system's ThemeProvider (localStorage).
const OPTIONS = [
  { value: "light" as const, label: "ライト", Icon: SunIcon },
  { value: "dark" as const, label: "ダーク", Icon: MoonIcon },
  { value: "system" as const, label: "自動", Icon: MonitorIcon },
];

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  return (
    <div className="nk-theme-toggle" role="group" aria-label="テーマ">
      {OPTIONS.map(({ value, label, Icon }) => (
        <button
          key={value}
          type="button"
          className={`nk-theme-opt${theme === value ? " is-active" : ""}`}
          aria-pressed={theme === value}
          title={label}
          onClick={() => setTheme(value)}
        >
          <Icon size={14} />
        </button>
      ))}
    </div>
  );
}
