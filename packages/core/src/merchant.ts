// Pure merchant-memory helpers; the database read lives in the server layer
// (server/src/lib/autoCategorize.ts mirrors this normalization).

// Bank descriptors carry per-charge noise (store numbers, auth codes, dates:
// "STARBUCKS #1234 SEATTLE" vs "STARBUCKS #0987 SEATTLE"); the letters are the
// stable part, so normalize down to them.
export function normalizeMerchant(description: string): string {
  return description.toLowerCase().replace(/[^a-z]+/g, " ").trim();
}

// One suggestion (category id or null) per input description, by exact
// normalized-merchant match against the ledger's history. Exact-only on
// purpose: a wrong guess costs the user more than no guess. `history` must be
// ordered newest-first -- the first hit per merchant is the most recent usage,
// which is also the better signal when a merchant was re-categorized.
export function suggestFromHistory(
  history: { description: string; category_id: number | null }[],
  descriptions: string[],
): (number | null)[] {
  const wanted = new Set(descriptions.map(normalizeMerchant));
  wanted.delete("");
  if (wanted.size === 0) return descriptions.map(() => null);

  const byMerchant = new Map<string, number>();
  for (const row of history) {
    if (row.category_id == null) continue;
    const key = normalizeMerchant(row.description);
    if (!key || !wanted.has(key) || byMerchant.has(key)) continue;
    byMerchant.set(key, row.category_id);
  }

  return descriptions.map((d) => byMerchant.get(normalizeMerchant(d)) ?? null);
}
