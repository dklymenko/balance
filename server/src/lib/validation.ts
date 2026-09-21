import type { Response } from "express";

// Routes tag expected failures with a `status` (see assertStorableCents and
// the linked-transfer guards) so a catch block can answer with that code
// instead of a blanket 500.
export function errorStatus(err: unknown): number | null {
  const status = (err as { status?: unknown } | null)?.status;
  return status === 400 || status === 404 || status === 409 ? status : null;
}

// Expected, caller-fixable failures carry a status: an out-of-range money
// value (400) or an incomplete linked transfer (409). Their message is written
// for the user and is safe to return. Anything else is a genuine fault, so log
// it server-side and answer with the route's generic message only, never the
// internal detail.
export function sendError(res: Response, err: unknown, fallback: string): void {
  const status = errorStatus(err);
  if (status !== null && err instanceof Error) {
    res.status(status).json({ error: err.message });
    return;
  }
  console.error(err);
  res.status(500).json({ error: fallback });
}

export function parsePositiveId(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647 ? value : null;
}

export function isRealDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day;
}
