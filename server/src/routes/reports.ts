import { Router } from "express";
import { and, eq, gte, inArray, notInArray, lte, sql, ne } from "drizzle-orm";
import type { DrizzleDB } from "../db/types.js";
import { transactions, categories, accounts } from "../db/schema.js";
import { fromCents } from "../lib/finance.js";

export function createReportsRouter(db: DrizzleDB) {
const router = Router();

// Every report excludes transactions belonging to accounts the user has flagged
// "exclude from reports". Expressed as a scoped sub-select so it needs no extra
// round trip; NOT IN over an empty set is all-true, so unflagged households are
// unaffected. accounts.id is NOT NULL, so no NULL-in-NOT-IN pitfall.
const notInExcludedAccount = () =>
  notInArray(
    transactions.account_id,
    db.select({ id: accounts.id }).from(accounts)
      .where(and(eq(accounts.exclude_from_reports, true))),
  );

function parseIds(raw: unknown): number[] | null | false {
  if (raw === undefined || raw === "") return null;
  if (typeof raw !== "string") return false;
  const parts = raw.split(",");
  if (parts.length > 1_000 || parts.some((part) => !/^\d+$/.test(part))) return false;
  const ids = parts.map(Number);
  return ids.every((id) => Number.isSafeInteger(id) && id > 0) ? [...new Set(ids)] : false;
}

function isMonth(value: string): boolean {
  return /^\d{4}-(?:0[1-9]|1[0-2])$/.test(value);
}

function isDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [, year, month, day] = match.map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

// `date` is stored as ISO text 'YYYY-MM-DD', so the YYYY-MM / YYYY grouping keys
// are just leading substrings (no cast or to_char needed). Fresh sql fragments
// per call so the same expression can appear in select/group/order/filter.
const monthOf = () => sql<string>`substr(${transactions.date}, 1, 7)`;
const yearOf = () => sql<string>`substr(${transactions.date}, 1, 4)`;

function monthBetween(start: string, end: string) {
  return [gte(monthOf(), start), lte(monthOf(), end)] as const;
}

// GET /api/reports/spend-by-category
// ?start=YYYY-MM&end=YYYY-MM&account_ids=1,2,3
router.get("/spend-by-category", async (req, res) => {
  try {
    const start  = String(req.query.start  || "2000-01");
    const end    = String(req.query.end    || "2099-12");
    const accIds = parseIds(req.query.account_ids);
    if (!isMonth(start) || !isMonth(end) || start > end) return res.status(400).json({ error: "start and end must be an ordered YYYY-MM range" });
    if (accIds === false) return res.status(400).json({ error: "account_ids must contain positive integers" });

    const where = and(eq(transactions.type, "debit"),
      eq(transactions.exclude_from_reports, false),
      notInExcludedAccount(),
      ...monthBetween(start, end),
      accIds ? inArray(transactions.account_id, accIds) : undefined
    );

    const rows = await db
      .select({
        category_id:   transactions.category_id,
        category_name: categories.name,
        parent_id:     categories.parent_id,
        total_usd:     sql<number>`SUM(${transactions.amount_usd})`,
      })
      .from(transactions)
      .leftJoin(categories, eq(transactions.category_id, categories.id))
      .where(where)
      // Keep every selected non-aggregate explicit in GROUP BY.
      .groupBy(transactions.category_id, categories.name, categories.parent_id);

    res.json(rows.map(r => ({ ...r, total_usd: fromCents(Number(r.total_usd)) })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch spend by category" });
  }
});

// GET /api/reports/spend-over-time
// ?start=YYYY-MM&end=YYYY-MM&account_ids=1,2&category_ids=1,2
router.get("/spend-over-time", async (req, res) => {
  try {
    const start   = String(req.query.start  || "2000-01");
    const end     = String(req.query.end    || "2099-12");
    const accIds  = parseIds(req.query.account_ids);
    const catIds  = parseIds(req.query.category_ids);
    if (!isMonth(start) || !isMonth(end) || start > end) return res.status(400).json({ error: "start and end must be an ordered YYYY-MM range" });
    if (accIds === false || catIds === false) return res.status(400).json({ error: "filter ids must contain positive integers" });

    const where = and(eq(transactions.type, "debit"),
      eq(transactions.exclude_from_reports, false),
      notInExcludedAccount(),
      ...monthBetween(start, end),
      accIds ? inArray(transactions.account_id, accIds) : undefined,
      catIds ? inArray(transactions.category_id, catIds) : undefined
    );

    const rows = await db
      .select({
        period:    monthOf(),
        total_usd: sql<number>`SUM(${transactions.amount_usd})`,
      })
      .from(transactions)
      .where(where)
      .groupBy(monthOf())
      .orderBy(monthOf());

    res.json(rows.map(r => ({ period: r.period, total_usd: fromCents(Number(r.total_usd)) })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch spend over time" });
  }
});

// GET /api/reports/income-spend-savings
// ?start=YYYY-MM&end=YYYY-MM&account_ids=1,2&group_by=month|year
router.get("/income-spend-savings", async (req, res) => {
  try {
    const start   = String(req.query.start   || "2000-01");
    const end     = String(req.query.end     || "2099-12");
    if (req.query.group_by !== undefined && req.query.group_by !== "year" && req.query.group_by !== "month") {
      return res.status(400).json({ error: "group_by must be month or year" });
    }
    const groupBy = req.query.group_by === "year" ? "year" : "month";
    const accIds  = parseIds(req.query.account_ids);
    if (!isMonth(start) || !isMonth(end) || start > end) return res.status(400).json({ error: "start and end must be an ordered YYYY-MM range" });
    if (accIds === false) return res.status(400).json({ error: "account_ids must contain positive integers" });

    const periodExpr = () => (groupBy === "year" ? yearOf() : monthOf());

    const where = and(ne(transactions.type, "transfer"),
      eq(transactions.exclude_from_reports, false),
      notInExcludedAccount(),
      ...monthBetween(start, end),
      accIds ? inArray(transactions.account_id, accIds) : undefined
    );

    const rows = await db
      .select({
        period:  periodExpr(),
        income:  sql<number>`SUM(CASE WHEN ${transactions.type} = 'credit' THEN ${transactions.amount_usd} ELSE 0 END)`,
        spend:   sql<number>`SUM(CASE WHEN ${transactions.type} = 'debit'  THEN ${transactions.amount_usd} ELSE 0 END)`,
      })
      .from(transactions)
      .where(where)
      .groupBy(periodExpr())
      .orderBy(periodExpr());

    const withSavings = (rows as { period: string; income: number; spend: number }[]).map(r => {
      const income = fromCents(Number(r.income));
      const spend = fromCents(Number(r.spend));
      return { period: r.period, income, spend, savings: income - spend };
    });

    res.json(withSavings);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch income/spend/savings" });
  }
});

  // GET /api/reports/spend-by-day
  // ?start=YYYY-MM-DD&end=YYYY-MM-DD&account_ids=1,2 -- daily debit totals,
  // used by the Period-comparison report's cumulative curves.
  router.get("/spend-by-day", async (req, res) => {
    try {
      const start  = String(req.query.start || "2000-01-01");
      const end    = String(req.query.end   || "2099-12-31");
      const accIds = parseIds(req.query.account_ids);
      if (!isDate(start) || !isDate(end) || start > end) return res.status(400).json({ error: "start and end must be an ordered YYYY-MM-DD range" });
      if (accIds === false) return res.status(400).json({ error: "account_ids must contain positive integers" });

      const where = and(eq(transactions.type, "debit"),
        eq(transactions.exclude_from_reports, false),
        notInExcludedAccount(),
        gte(transactions.date, start),
        lte(transactions.date, end),
        accIds ? inArray(transactions.account_id, accIds) : undefined
      );

      const rows = await db
        .select({
          date:      transactions.date,
          total_usd: sql<number>`SUM(${transactions.amount_usd})`,
        })
        .from(transactions)
        .where(where)
        .groupBy(transactions.date)
        .orderBy(transactions.date);

      res.json(rows.map(r => ({ date: r.date, total_usd: fromCents(Number(r.total_usd)) })));
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to fetch spend by day" });
    }
  });

  return router;
}

export default createReportsRouter;
