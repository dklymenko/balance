import { and, desc, isNotNull } from "drizzle-orm";
import type { DrizzleDB } from "../db/types.js";
import { transactions } from "../db/schema.js";

// Merchant-memory auto-categorization: suggest the category last used for the
// same merchant, learned purely from this local ledger. No external service.

// Bank descriptors carry per-charge noise (store numbers, auth codes, dates:
// "STARBUCKS #1234 SEATTLE" vs "STARBUCKS #0987 SEATTLE"); the letters are the
// stable part, so normalize down to them.
export function normalizeMerchant(description: string): string {
  return description.toLowerCase().replace(/[^a-z]+/g, " ").trim();
}

// Only scan the newest slice of the ledger; recent usage is also the better
// signal when a merchant was re-categorized over time.
const LOOKBACK_ROWS = 2000;

// One suggestion (category id or null) per input description, by exact
// normalized-merchant match. Exact-only on purpose: a wrong guess costs the
// user more than no guess.
export async function suggestCategories(
  db: DrizzleDB,
  descriptions: string[],
): Promise<(number | null)[]> {
  const wanted = new Set(descriptions.map(normalizeMerchant));
  wanted.delete("");
  if (wanted.size === 0) return descriptions.map(() => null);

  const history = await db
    .select({ description: transactions.description, category_id: transactions.category_id })
    .from(transactions)
    .where(and(isNotNull(transactions.category_id)))
    .orderBy(desc(transactions.id))
    .limit(LOOKBACK_ROWS);

  const byMerchant = new Map<string, number>();
  for (const row of history) {
    const key = normalizeMerchant(row.description);
    if (!key || !wanted.has(key) || byMerchant.has(key)) continue; // first hit = most recent
    byMerchant.set(key, row.category_id as number);
  }

  return descriptions.map((d) => byMerchant.get(normalizeMerchant(d)) ?? null);
}
