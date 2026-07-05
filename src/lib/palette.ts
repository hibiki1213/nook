// Deterministic color for a select option so the same value always gets the same
// chip color. Uses the design-system semantic color tokens.
const PALETTE = [
  { bg: "var(--color-accent-3)", fg: "var(--color-accent-11)" },
  { bg: "var(--bg-success)", fg: "var(--text-success)" },
  { bg: "var(--bg-warning)", fg: "var(--text-warning)" },
  { bg: "var(--bg-danger)", fg: "var(--text-danger)" },
  { bg: "var(--color-gray-4)", fg: "var(--color-gray-11)" },
  { bg: "var(--bg-info)", fg: "var(--text-accent)" },
];

// Solid colors for chart/bar segments, index-aligned with PALETTE so a select
// option's chip and its summary-bar segment read as the same hue family.
const BAR_PALETTE = [
  "var(--color-blue)",
  "var(--color-green)",
  "var(--color-orange)",
  "var(--color-red)",
  "var(--color-gray-8)",
  "var(--color-purple)",
  "var(--color-pink)",
  "var(--color-yellow)",
];

function paletteIndex(value: string, options?: string[]): number {
  if (options && options.length > 0) {
    const i = options.indexOf(value);
    return i >= 0 ? i : hash(value);
  }
  return hash(value);
}

/** Pick a stable palette entry for `value` within a field's option list. */
export function chipColor(value: string, options?: string[]) {
  return PALETTE[paletteIndex(value, options) % PALETTE.length];
}

/** Solid segment color for `value` — same index logic as `chipColor`. */
export function barColor(value: string, options?: string[]): string {
  return BAR_PALETTE[paletteIndex(value, options) % BAR_PALETTE.length];
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}
