import { useSyncExternalStore } from "react";
import type { CSSProperties } from "react";
import {
  ACCENTS,
  currentAccent,
  setAccent,
  subscribeAccent,
} from "../lib/accent";

// Accent color picker — a labeled swatch grid (lives in the settings modal).
// Dots keep their own hue (not the live accent vars) so every choice stays
// visible whichever accent is active.
export function AccentPicker() {
  const accent = useSyncExternalStore(subscribeAccent, currentAccent);
  return (
    <div className="nk-accent-grid" role="group" aria-label="アクセントカラー">
      {ACCENTS.map((a) => (
        <button
          key={a.id}
          type="button"
          className={`nk-accent-swatch${accent === a.id ? " is-active" : ""}`}
          aria-pressed={accent === a.id}
          onClick={() => setAccent(a.id)}
        >
          <span
            className="nk-accent-dot"
            style={{ "--dot": a.dot } as CSSProperties}
          />
          <span className="nk-accent-name">{a.label}</span>
        </button>
      ))}
    </div>
  );
}
