import type { ParsedRow } from "./csvParsers";

interface ExistingTx {
  date: string;
  amount_usd: number;
  amount_fx?: number;
  description: string;
  type: "debit" | "credit" | "transfer";
}

function normalizedDescription(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase("en-US");
}

function identity(date: string, cents: number, description: string, type: string): string {
  return `${date}|${cents}|${type}|${normalizedDescription(description)}`;
}

export function dedupeRows(
  incoming: ParsedRow[],
  existing: ExistingTx[],
  windowDays = 0
): { rows: ParsedRow[]; skipped: number } {
  const windowMs = windowDays * 24 * 60 * 60 * 1000;
  const known = new Set(existing.map((e) => identity(
    e.date,
    Math.round((e.amount_fx ?? e.amount_usd) * 100),
    e.description,
    e.type,
  )));
  const rows = incoming.filter((r) => {
    const cents = Math.round(Number(r.amount) * 100);
    const time = new Date(r.date).getTime();
    const duplicate = existing.some((e) => {
      if (Math.round((e.amount_fx ?? e.amount_usd) * 100) !== cents) return false;
      if (e.type !== r.type || normalizedDescription(e.description) !== normalizedDescription(r.description)) return false;
      return Math.abs(new Date(e.date).getTime() - time) <= windowMs;
    }) || known.has(identity(r.date, cents, r.description, r.type));
    if (duplicate) return false;
    known.add(identity(r.date, cents, r.description, r.type));
    return true;
  });
  return { rows, skipped: incoming.length - rows.length };
}

export interface DupeWarning {
  match_id: number;
  match_date: string;
  match_amount_usd: number;
  match_account_name: string | null;
  match_description: string;
}

interface ExistingTxWithMeta extends ExistingTx {
  id: number;
  account_name: string | null;
  description: string;
}

// Returns one warning per incoming row (or null if no match) -- used to flag
// potential cross-account duplicates without silently dropping the row. The
// user decides whether to keep or delete in the import preview.
export function findPotentialDupes(
  incoming: ParsedRow[],
  existing: ExistingTxWithMeta[],
  windowDays = 5
): (DupeWarning | null)[] {
  const windowMs = windowDays * 24 * 60 * 60 * 1000;
  return incoming.map((r) => {
    const cents = Math.round(Number(r.amount) * 100);
    const time = new Date(r.date).getTime();
    const hit = existing.find((e) => {
      if (Math.round(e.amount_usd * 100) !== cents) return false;
      return Math.abs(new Date(e.date).getTime() - time) <= windowMs;
    });
    return hit
      ? {
          match_id: hit.id,
          match_date: hit.date,
          match_amount_usd: hit.amount_usd,
          match_account_name: hit.account_name,
          match_description: hit.description,
        }
      : null;
  });
}
