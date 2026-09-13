import { Router } from "express";
import { and, eq, gte, notInArray } from "drizzle-orm";
import type { DrizzleDB } from "../db/types.js";
import { transactions, categories, accounts } from "../db/schema.js";
import { fromCents } from "../lib/finance.js";
import { normalizeMerchant } from "../lib/autoCategorize.js";

// Recurring-charge detection is a read-only analysis of the user's own ledger;
// it does not copy or persist transaction data.
//
// A merchant counts as a subscription when, within the last ~13 months:
// - it has at least MIN_CHARGES debit charges,
// - every gap between consecutive charges is a month-ish interval, and
// - the amounts are stable (within $1 or 25% of the median, whichever is more).

const LOOKBACK_DAYS = 396; // ~13 months, so 12 monthly charges + jitter fit
const MIN_CHARGES = 3;
const MONTHLY_GAP_MIN_DAYS = 25;
const MONTHLY_GAP_MAX_DAYS = 35;

const DAY_MS = 24 * 60 * 60 * 1000;

function median(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

export interface Subscription {
  merchant: string;          // normalized key
  description: string;       // most recent raw descriptor
  category_name: string | null;
  monthly_usd: number;       // dollars (median charge)
  last_charge: string;       // YYYY-MM-DD
  charges: number;
}

export function detectSubscriptions(
  rows: { date: string; description: string; amount_usd: number; category_name: string | null }[],
): Subscription[] {
  const byMerchant = new Map<string, typeof rows>();
  for (const r of rows) {
    const key = normalizeMerchant(r.description);
    if (!key) continue;
    const list = byMerchant.get(key);
    if (list) list.push(r); else byMerchant.set(key, [r]);
  }

  const found: Subscription[] = [];
  for (const [merchant, charges] of byMerchant) {
    if (charges.length < MIN_CHARGES) continue;
    charges.sort((a, b) => a.date.localeCompare(b.date));

    let monthly = true;
    for (let i = 1; i < charges.length; i++) {
      const gapDays = (Date.parse(charges[i].date) - Date.parse(charges[i - 1].date)) / DAY_MS;
      if (gapDays < MONTHLY_GAP_MIN_DAYS || gapDays > MONTHLY_GAP_MAX_DAYS) { monthly = false; break; }
    }
    if (!monthly) continue;

    const amounts = charges.map((c) => c.amount_usd).sort((a, b) => a - b);
    const mid = median(amounts);
    const tolerance = Math.max(100, Math.round(mid * 0.25)); // cents
    if (amounts[amounts.length - 1] - amounts[0] > tolerance) continue;

    const latest = charges[charges.length - 1];
    found.push({
      merchant,
      description: latest.description,
      category_name: latest.category_name,
      monthly_usd: fromCents(mid),
      last_charge: latest.date,
      charges: charges.length,
    });
  }

  return found.sort((a, b) => b.monthly_usd - a.monthly_usd);
}

export function createInsightsRouter(db: DrizzleDB) {
  const router = Router();

  // GET /api/insights/subscriptions → { subscriptions, total_monthly_usd }
  router.get("/subscriptions", async (req, res) => {
    try {
      const cutoff = new Date(Date.now() - LOOKBACK_DAYS * DAY_MS).toISOString().slice(0, 10);
      const rows = await db
        .select({
          date: transactions.date,
          description: transactions.description,
          amount_usd: transactions.amount_usd,
          category_name: categories.name,
        })
        .from(transactions)
        .leftJoin(categories, eq(transactions.category_id, categories.id))
        .where(and(eq(transactions.type, "debit"),
          eq(transactions.exclude_from_reports, false),
          notInArray(
            transactions.account_id,
            db.select({ id: accounts.id }).from(accounts)
              .where(eq(accounts.exclude_from_reports, true)),
          ),
          gte(transactions.date, cutoff),
        ));

      const subscriptions = detectSubscriptions(rows);
      const total = subscriptions.reduce((s, x) => s + x.monthly_usd, 0);
      res.json({ subscriptions, total_monthly_usd: Math.round(total * 100) / 100 });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to detect subscriptions" });
    }
  });

  return router;
}

export default createInsightsRouter;
