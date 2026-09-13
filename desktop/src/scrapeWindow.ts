import type { ScrapeWindow } from "./types";

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isCalendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_DATE_RE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function parseScrapeWindow(raw: unknown): ScrapeWindow | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { oldestIso, newestIso } = raw as Record<string, unknown>;
  if (!isCalendarDate(oldestIso) || !isCalendarDate(newestIso)) return null;
  if (oldestIso > newestIso) return null;
  return { oldestIso, newestIso };
}
