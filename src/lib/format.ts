// Value formatting helpers shared by field renderers.

/** Format a numeric amount as currency (defaults to JPY). Falls back to a plain
 *  number + code if the runtime doesn't recognize the currency. */
export function formatMoney(value: unknown, currency = "JPY"): string {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return String(value ?? "");
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(n);
  } catch {
    return `${n.toLocaleString()} ${currency}`;
  }
}

/** Coerce a stored tags value into a string array (tolerant of legacy strings). */
export function toTags(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter((s) => s !== "");
  if (typeof value === "string" && value.trim() !== "") {
    return value.split(",").map((s) => s.trim()).filter(Boolean);
  }
  return [];
}
