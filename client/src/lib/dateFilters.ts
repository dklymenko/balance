const DAY_MS = 24 * 60 * 60 * 1000;

export function isWithinLast24h(iso: string, nowMs: number = Date.now()): boolean {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return false;
  const delta = nowMs - t;
  return delta >= 0 && delta < DAY_MS;
}

// Date-range presets for the transactions filter. All ranges are computed in the
// device's local timezone so "This month" matches the user's calendar.
export type DatePreset =
  | "all" | "this-month" | "last-month" | "last-3-months" | "this-year" | "custom";

export const DATE_PRESET_LABELS: Record<DatePreset, string> = {
  "all": "All time",
  "this-month": "This month",
  "last-month": "Last month",
  "last-3-months": "Last 3 months",
  "this-year": "This year",
  "custom": "Custom",
};

function localYmd(d: Date): string {
  const tz = d.getTime() - d.getTimezoneOffset() * 60000;
  return new Date(tz).toISOString().slice(0, 10);
}

// {from, to} (inclusive, YYYY-MM-DD) for a preset, or null for "all"/"custom"
// (the caller supplies its own range for "custom").
export function presetToRange(preset: DatePreset, now: Date = new Date()): { from: string; to: string } | null {
  const y = now.getFullYear();
  const m = now.getMonth();
  const today = localYmd(now);
  switch (preset) {
    case "this-month":
      return { from: localYmd(new Date(y, m, 1)), to: today };
    case "last-month":
      return { from: localYmd(new Date(y, m - 1, 1)), to: localYmd(new Date(y, m, 0)) };
    case "last-3-months":
      return { from: localYmd(new Date(y, m - 2, 1)), to: today };
    case "this-year":
      return { from: localYmd(new Date(y, 0, 1)), to: today };
    default:
      return null;
  }
}
