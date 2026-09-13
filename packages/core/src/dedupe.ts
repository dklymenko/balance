// Integer-cents import dedupe shared by device CSV flows: drop rows that
// already exist in the ledger within a ±windowDays window.

export interface IncomingRow {
  date: string; // YYYY-MM-DD
  amount_cents: number;
}

export interface ExistingTx {
  date: string;
  amount_cents: number;
}

export function dedupeRows<T extends IncomingRow>(
  incoming: T[],
  existing: ExistingTx[],
  windowDays = 3,
): { rows: T[]; skipped: number } {
  const windowMs = windowDays * 24 * 60 * 60 * 1000;
  const rows = incoming.filter((r) => {
    const time = new Date(r.date).getTime();
    return !existing.some((e) => {
      if (e.amount_cents !== r.amount_cents) return false;
      return Math.abs(new Date(e.date).getTime() - time) <= windowMs;
    });
  });
  return { rows, skipped: incoming.length - rows.length };
}
