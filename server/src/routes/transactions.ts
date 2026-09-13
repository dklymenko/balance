import { Router } from "express";
import { randomUUID } from "node:crypto";
import { eq, desc, inArray, and, or, gte, lte, isNull, sql } from "drizzle-orm";
import { parse } from "csv-parse/sync";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { DrizzleDB } from "../db/types.js";
import { runTransaction } from "../db/tx.js";
import { transactions, accounts, categories, transactionTags, tags } from "../db/schema.js";
import type { TransactionType } from "../db/schema.js";
import { parseBudgetAppAmount, toCents, fromCents, assertStorableCents, deriveUsdCents } from "../lib/finance.js";
import { suggestCategories } from "../lib/autoCategorize.js";
import { recomputeAccounts, recomputeAccountBalance } from "../lib/recompute.js";
import { recordChange } from "../lib/ledgerHooks.js";
import { parsePositiveId, sendError } from "../lib/validation.js";

// Account/category mapping is loaded from server/data/budget-app-mapping.json (gitignored).
// See server/budget-app-mapping.example.json for the schema. Empty fallback if missing --
// the importer just won't recognize any source-side names.
export type BudgetAppMapping = {
  accounts: Record<string, string>;
  categoryChildOverrides: Record<string, string>;
};

export function budgetAppMappingPath(explicitPath = process.env.BALANCE_BUDGET_APP_MAPPING): string {
  // Resolve the conventional private file relative to this package, not the
  // process cwd. Desktop launches from the repository root while `npm run dev`
  // launches in server/, and both must find the same server/data file.
  return explicitPath
    ? resolve(explicitPath)
    : fileURLToPath(new URL("../../data/budget-app-mapping.json", import.meta.url));
}

function loadBudgetAppMapping(): BudgetAppMapping {
  const path = budgetAppMappingPath();
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw);
    return {
      accounts: parsed.accounts ?? {},
      categoryChildOverrides: parsed.categoryChildOverrides ?? {},
    };
  } catch {
    return { accounts: {}, categoryChildOverrides: {} };
  }
}

const BUDGET_APP_MAPPING = loadBudgetAppMapping();

function buildBudgetAppAccountMap(
  allAccounts: { id: number; name: string }[],
  mapping: BudgetAppMapping,
): Record<string, number> {
  const byName = Object.fromEntries(allAccounts.map(a => [a.name, a.id]));
  const result: Record<string, number> = {};
  for (const [srcName, balanceName] of Object.entries(mapping.accounts)) {
    if (byName[balanceName] !== undefined) result[srcName] = byName[balanceName];
  }
  return result;
}

function buildBudgetAppCategoryMap(
  allCats: { id: number; name: string; parent_id: number | null }[],
  mapping: BudgetAppMapping,
): Record<string, number> {
  const byId = new Map(allCats.map(c => [c.id, c]));
  const map: Record<string, number> = {};
  for (const cat of allCats) {
    if (cat.parent_id === null) {
      map[cat.name] = cat.id;
    } else {
      const parent = byId.get(cat.parent_id);
      if (parent) {
        map[`${parent.name} / ${cat.name}`] = cat.id;
        for (const [srcChild, balanceChild] of Object.entries(mapping.categoryChildOverrides)) {
          if (cat.name === balanceChild) map[`${parent.name} / ${srcChild}`] = cat.id;
        }
      }
    }
  }
  return map;
}

// "1,2,3" → [1, 2, 3]. undefined means absent; null means malformed.
// Reject the entire filter rather than silently dropping bad list members.
function parseIds(raw: unknown): number[] | null | undefined {
  if (raw === undefined || raw === "") return undefined;
  if (typeof raw !== "string") return null;
  const parts = raw.split(",").map((part) => part.trim());
  if (parts.length === 0 || parts.length > 100 || parts.some((part) => !/^\d+$/.test(part))) return null;
  const ids = parts.map(Number);
  if (ids.some((id) => !Number.isSafeInteger(id) || id <= 0 || id > 2_147_483_647)) return null;
  return [...new Set(ids)];
}

// Valid transaction types. The DB column is plain text (no enum/check), so the
// allow-list is enforced here at the API boundary.
const TRANSACTION_TYPES = new Set<TransactionType>(["debit", "credit", "transfer"]);
function isValidType(t: unknown): t is TransactionType {
  return typeof t === "string" && TRANSACTION_TYPES.has(t as TransactionType);
}

const MAX_MONEY = 1e12;
function isValidDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

function validPositiveNumber(value: unknown, max = MAX_MONEY): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= max;
}

function validateTransactionBody(body: Record<string, unknown>): string | null {
  if (!Number.isInteger(body.account_id) || (body.account_id as number) <= 0) return "account_id must be a positive integer";
  if (body.category_id != null && (!Number.isInteger(body.category_id) || (body.category_id as number) <= 0)) return "category_id must be a positive integer or null";
  if (!isValidDate(body.date)) return "date must be a real calendar date in YYYY-MM-DD format";
  if (!validPositiveNumber(body.amount_fx)) return "amount_fx must be a positive finite number";
  if (body.exchange_rate !== undefined && !validPositiveNumber(body.exchange_rate, 1e9)) return "exchange_rate must be a positive finite number";
  if (body.description !== undefined && (typeof body.description !== "string" || body.description.length > 10_000)) return "description is too long";
  if (body.exclude_from_reports !== undefined && typeof body.exclude_from_reports !== "boolean") return "exclude_from_reports must be a boolean";
  return null;
}

// Parse an optional numeric query param. undefined = absent/empty (skip the
// filter); null = present but not a finite number (caller returns 400).
function numParam(raw: unknown): number | null | undefined {
  if (raw === undefined || raw === "") return undefined;
  if (typeof raw !== "string") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function positiveIdParam(raw: unknown): number | null | undefined {
  if (raw === undefined || raw === "") return undefined;
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 && id <= 2_147_483_647 ? id : null;
}

// Parse an optional multi-type filter, e.g. "debit,credit". undefined = absent;
// null = present but contains an invalid type (caller returns 400).
function parseTypes(raw: unknown): TransactionType[] | null | undefined {
  if (raw === undefined || raw === "") return undefined;
  const parts = String(raw).split(",").map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return undefined;
  if (!parts.every(isValidType)) return null;
  return parts as TransactionType[];
}

// Money is stored as integer cents; the API speaks dollars. Convert a row's
// money fields to dollars on the way out.
function txToApi<T extends { amount_fx: number; amount_usd: number }>(row: T) {
  return { ...row, amount_fx: fromCents(row.amount_fx), amount_usd: fromCents(row.amount_usd) };
}

// Structural subset of DrizzleDB that both the pool db and a db.transaction
// executor satisfy, so balance updates can run inside a transaction.
type DbExecutor = Pick<DrizzleDB, "select" | "update" | "insert" | "delete">;

export function createTransactionsRouter(db: DrizzleDB, budgetAppMapping: BudgetAppMapping = BUDGET_APP_MAPPING) {
  const router = Router();

  // Balance writes flow through recomputeAccountBalance() (frozen-delta
  // model): balance is a pure function of the rows, so replicas converge. The
  // old incremental applyAccountDelta path is retired. recordChange() is the
  // sync hook -- a no-op locally, the outbox feed on Desktop.

  // Income categories (Salary, etc.) may only be used on credit transactions.
  // Returns an error message if the (category, type) pair is invalid, else null.
  async function incomeViolation(
    categoryId: number | null | undefined,
    type: TransactionType | undefined,
  ): Promise<string | null> {
    if (categoryId == null || type !== "debit") return null;
    const [cat] = await db.select().from(categories)
      .where(and(eq(categories.id, categoryId)));
    if (cat?.kind === "income") {
      return `Category "${cat.name}" is an income category and can only be used on credit (money-in) transactions.`;
    }
    return null;
  }

  // Foreign-key guards turn malformed references into clear 400 responses
  // instead of relying on database errors or dangling values.
  async function ownsAccount(accountId: number | null | undefined): Promise<boolean> {
    if (!Number.isInteger(accountId) || (accountId as number) <= 0) return false;
    const id = accountId as number;
    const [row] = await db.select({ id: accounts.id }).from(accounts)
      .where(and(eq(accounts.id, id)));
    return !!row;
  }

  async function transferAccount(accountId: number) {
    const [row] = await db.select({
      id: accounts.id,
      exchange_rate: accounts.exchange_rate,
    }).from(accounts).where(eq(accounts.id, accountId));
    return row ?? null;
  }

  function transferAmounts(amountFx: number, fromRate: number, toRate: number) {
    const outFx = assertStorableCents(toCents(amountFx), "amount_fx");
    const usd = deriveUsdCents(outFx, fromRate);
    // The receiving leg divides by the destination rate, so a very small rate
    // can push the inbound amount out of range even when the USD value fits.
    const inFx = assertStorableCents(Math.round(usd / toRate), "converted transfer amount");
    return { outFx, inFx, usd };
  }
  async function ownsCategory(categoryId: number | null | undefined): Promise<boolean> {
    if (categoryId == null) return true; // null = uncategorized, always allowed
    if (!Number.isInteger(categoryId) || categoryId <= 0) return false;
    const [row] = await db.select({ id: categories.id }).from(categories)
      .where(and(eq(categories.id, categoryId)));
    return !!row;
  }

  async function attachTags<T extends { id: number }>(
    rows: T[],
  ): Promise<(T & { tags: { id: number; name: string }[] })[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const tagRows = await db
      .select({
        transaction_id: transactionTags.transaction_id,
        tag_id: tags.id,
        tag_name: tags.name,
      })
      .from(transactionTags)
      .innerJoin(tags, eq(transactionTags.tag_id, tags.id))
      .where(inArray(transactionTags.transaction_id, ids));

    const byTxId: Record<number, { id: number; name: string }[]> = {};
    for (const r of tagRows) {
      if (!byTxId[r.transaction_id]) byTxId[r.transaction_id] = [];
      byTxId[r.transaction_id].push({ id: r.tag_id, name: r.tag_name });
    }
    return rows.map((r) => ({ ...r, tags: byTxId[r.id] ?? [] }));
  }

  // For transfer legs, resolve the counterparty account so each row can render
  // "from -> to" even when the result is filtered to a single account. Legs
  // created since transfer_group_id exist are paired exactly by that id; the
  // date+amount heuristic (2-cent window on integer cents, nearest id) remains
  // only for legacy rows without one. Scoped to the household so it never pairs
  // against unrelated or malformed transfer groups.
  async function attachTransferParties<T extends {
    id: number; account_id: number; account_name: string | null;
    date: string; amount_usd: number; type: string; transfer_group_id?: string | null;
    transfer_direction?: "out" | "in" | null;
  }>( rows: T[]): Promise<(T & { transfer_from?: string | null; transfer_to?: string | null })[]> {
    const legs = rows.filter((r) => r.type === "transfer");
    if (legs.length === 0) return rows;

    const dates = [...new Set(legs.map((r) => r.date))];
    const candidates = await db
      .select({
        id: transactions.id,
        account_id: transactions.account_id,
        account_name: accounts.name,
        date: transactions.date,
        amount_usd: transactions.amount_usd,
        transfer_group_id: transactions.transfer_group_id,
        transfer_direction: transactions.transfer_direction,
      })
      .from(transactions)
      .leftJoin(accounts, eq(transactions.account_id, accounts.id))
      .where(and(eq(transactions.type, "transfer" as TransactionType), inArray(transactions.date, dates)));

    function partnerFor(leg: T) {
      if (leg.transfer_group_id) {
        return candidates.find((c) => c.transfer_group_id === leg.transfer_group_id && c.id !== leg.id) ?? null;
      }
      let best: (typeof candidates)[number] | null = null;
      let bestGap = Infinity;
      for (const c of candidates) {
        if (c.transfer_group_id || c.id === leg.id || c.account_id === leg.account_id || c.date !== leg.date) continue;
        if (Math.abs(c.amount_usd - leg.amount_usd) >= 2) continue; // within 2 cents
        const gap = Math.abs(c.id - leg.id);
        if (gap < bestGap) { bestGap = gap; best = c; }
      }
      return best;
    }

    return rows.map((r) => {
      if (r.type !== "transfer") return r;
      const partner = partnerFor(r);
      if (!partner) return { ...r, transfer_from: r.account_name, transfer_to: null };
      const rIsOut = r.transfer_direction === "out" ||
        (r.transfer_direction == null && r.id < partner.id);
      const [transfer_from, transfer_to] = rIsOut
        ? [r.account_name, partner.account_name]
        : [partner.account_name, r.account_name];
      return { ...r, transfer_from, transfer_to };
    });
  }

  // GET /api/transactions
  // Paginated + server-side filtered. Returns { rows, total }.
  // Query params (all optional): limit (default -1 = all), offset,
  //   account_ids=1,2 (or legacy single account_id), category_id, amount_min,
  //   amount_max, tag_id, recent=1 (created in the last 24h), date_from,
  //   date_to (inclusive YYYY-MM-DD), types=debit,credit,transfer,
  //   uncategorized=1 (category_id IS NULL), category_ids=1,2,
  //   search=<amount|category|comment>.
  router.get("/", async (req, res) => {
    try {
      const q = req.query;

      // Pagination: limit (-1 = all; otherwise a non-negative cap), offset >= 0.
      // Validate here so malformed input is a 400, never a DB-level 500.
      const MAX_LIMIT = 1000;
      const rawLimit = q.limit === undefined ? -1 :
        typeof q.limit === "string" && /^-?\d+$/.test(q.limit) ? Number(q.limit) : Number.NaN;
      if (!Number.isSafeInteger(rawLimit) || (rawLimit < 0 && rawLimit !== -1)) {
        return res.status(400).json({ error: "limit must be -1 (all) or a non-negative integer" });
      }
      const limit = rawLimit === -1 ? -1 : Math.min(rawLimit, MAX_LIMIT);
      const rawOffset = q.offset === undefined || q.offset === "" ? 0 :
        typeof q.offset === "string" && /^\d+$/.test(q.offset) ? Number(q.offset) : Number.NaN;
      if (!Number.isSafeInteger(rawOffset) || rawOffset < 0) {
        return res.status(400).json({ error: "offset must be a non-negative integer" });
      }
      const offset = rawOffset;

      const conds = [];
      const accountIds = parseIds(q.account_ids);
      if (accountIds === null) return res.status(400).json({ error: "account_ids must be a comma-separated list of positive integers" });
      if (accountIds) conds.push(inArray(transactions.account_id, accountIds));
      else {
        const accountId = positiveIdParam(q.account_id);
        if (accountId === null) return res.status(400).json({ error: "account_id must be a positive integer" });
        if (accountId !== undefined) conds.push(eq(transactions.account_id, accountId));
      }
      const categoryIds = parseIds(q.category_ids);
      if (categoryIds === null) return res.status(400).json({ error: "category_ids must be a comma-separated list of positive integers" });
      if (categoryIds) conds.push(inArray(transactions.category_id, categoryIds));
      else {
        const categoryId = positiveIdParam(q.category_id);
        if (categoryId === null) return res.status(400).json({ error: "category_id must be a positive integer" });
        if (categoryId !== undefined) conds.push(eq(transactions.category_id, categoryId));
      }
      const amountMin = numParam(q.amount_min);
      if (amountMin === null || (amountMin !== undefined && (amountMin < 0 || amountMin > MAX_MONEY))) {
        return res.status(400).json({ error: `amount_min must be between 0 and ${MAX_MONEY}` });
      }
      if (amountMin !== undefined) conds.push(gte(transactions.amount_usd, toCents(amountMin)));
      const amountMax = numParam(q.amount_max);
      if (amountMax === null || (amountMax !== undefined && (amountMax < 0 || amountMax > MAX_MONEY))) {
        return res.status(400).json({ error: `amount_max must be between 0 and ${MAX_MONEY}` });
      }
      if (amountMin !== undefined && amountMax !== undefined && amountMin > amountMax) {
        return res.status(400).json({ error: "amount_min must not exceed amount_max" });
      }
      if (amountMax !== undefined) conds.push(lte(transactions.amount_usd, toCents(amountMax)));
      if (q.recent === "1" || q.recent === "true") {
        const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        conds.push(gte(transactions.created_at, cutoff));
      }
      const tagId = positiveIdParam(q.tag_id);
      if (tagId === null) return res.status(400).json({ error: "tag_id must be a positive integer" });
      if (tagId !== undefined) {
        conds.push(
          inArray(
            transactions.id,
            db
              .select({ id: transactionTags.transaction_id })
              .from(transactionTags)
              .where(eq(transactionTags.tag_id, tagId)),
          ),
        );
      }

      // Date range (inclusive), on the transaction's own date. Stored as
      // YYYY-MM-DD strings, which compare lexicographically.
      const dateFrom = q.date_from === undefined || q.date_from === "" ? undefined : q.date_from;
      if (dateFrom !== undefined && !isValidDate(dateFrom)) {
        return res.status(400).json({ error: "date_from must be a real calendar date in YYYY-MM-DD format" });
      }
      if (dateFrom) conds.push(gte(transactions.date, dateFrom));
      const dateTo = q.date_to === undefined || q.date_to === "" ? undefined : q.date_to;
      if (dateTo !== undefined && !isValidDate(dateTo)) {
        return res.status(400).json({ error: "date_to must be a real calendar date in YYYY-MM-DD format" });
      }
      if (dateFrom && dateTo && dateFrom > dateTo) {
        return res.status(400).json({ error: "date_from must not be after date_to" });
      }
      if (dateTo) conds.push(lte(transactions.date, dateTo));

      // Transaction types (multi-select): debit / credit / transfer.
      const types = parseTypes(q.types);
      if (types === null) return res.status(400).json({ error: "types must be a comma-separated list of debit|credit|transfer" });
      if (types !== undefined) conds.push(inArray(transactions.type, types));

      // Uncategorized only (category_id IS NULL).
      if (q.uncategorized === "1" || q.uncategorized === "true") {
        conds.push(isNull(transactions.category_id));
      }

      // Free-text search across the exact amount, category name, or description.
      // Category-name matches go through a subquery so the (join-less) count query
      // stays valid. lower(...) LIKE lower(...) keeps matching case-insensitive.
      if (q.search !== undefined && (typeof q.search !== "string" || q.search.length > 500)) {
        return res.status(400).json({ error: "search must be at most 500 characters" });
      }
      if (typeof q.search === "string" && q.search.trim()) {
        const term = q.search.trim();
        const like = `%${term.toLowerCase()}%`;
        const orParts = [
          sql`lower(${transactions.description}) like ${like}`,
          inArray(
            transactions.category_id,
            db.select({ id: categories.id }).from(categories).where(sql`lower(${categories.name}) like ${like}`),
          ),
        ];
        const numeric = term.replace(/[$,\s]/g, "");
        const num = Number(numeric);
        if (numeric !== "" && Number.isFinite(num)) {
          orParts.push(eq(transactions.amount_usd, toCents(Math.abs(num))));
        }
        conds.push(or(...orParts));
      }

      const whereClause = and(...conds);

      // Apply a LIMIT only when the caller requested a bounded page.
      let query = db
        .select({
          id: transactions.id,
          account_id: transactions.account_id,
          account_name: accounts.name,
          category_id: transactions.category_id,
          category_name: categories.name,
          date: transactions.date,
          description: transactions.description,
          amount_fx: transactions.amount_fx,
          exchange_rate: transactions.exchange_rate,
          amount_usd: transactions.amount_usd,
          type: transactions.type,
          transfer_group_id: transactions.transfer_group_id,
          transfer_direction: transactions.transfer_direction,
          exclude_from_reports: transactions.exclude_from_reports,
          created_at: transactions.created_at,
        })
        .from(transactions)
        // Joins are scoped by household too (defense in depth): even if a stray
        // row referenced a stale foreign id, it cannot resolve an unrelated
        // account or category name.
        .leftJoin(accounts, eq(transactions.account_id, accounts.id))
        .leftJoin(categories, eq(transactions.category_id, categories.id))
        .where(whereClause)
        .orderBy(desc(transactions.date), desc(transactions.id))
        .offset(offset)
        .$dynamic();
      if (limit >= 0) query = query.limit(limit);
      const rows = await query;

      const [{ total }] = await db
        .select({ total: sql<number>`count(*)` })
        .from(transactions)
        .where(whereClause);

      const enriched = (await attachTransferParties(await attachTags(rows))).map(txToApi);
      res.json({ rows: enriched, total: Number(total) });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to fetch transactions" });
    }
  });

  // POST /api/transactions/suggest-categories { descriptions: string[] }
  // → { suggestions: (number|null)[] }, one per input. Merchant-memory
  // auto-categorization from the user's own ledger, used by the CSV import
  // flow to prefill categories before the user reviews the rows.
  router.post("/suggest-categories", async (req, res) => {
    try {
      const { descriptions } = req.body as { descriptions?: unknown };
      if (
        !Array.isArray(descriptions) || descriptions.length === 0 ||
        descriptions.length > 1000 || !descriptions.every((d) => typeof d === "string")
      ) {
        return res.status(400).json({ error: "descriptions must be an array of up to 1000 strings" });
      }
      res.json({ suggestions: await suggestCategories(db, descriptions) });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to suggest categories" });
    }
  });

  // POST /api/transactions/bulk { rows: [...] } -- atomic bulk create for the
  // CSV-import / multi-add flow, replacing N sequential single POSTs (a 200-row
  // import used to be 200+ HTTP round trips, with a partial ledger on any
  // mid-loop failure). Rows are debit/credit only (transfers stay on
  // /transfer); every referenced account/category/tag id must exist; balance deltas are folded per
  // account; everything commits in one DB transaction or not at all.
  const BULK_MAX_ROWS = 1000;
  router.post("/bulk", async (req, res) => {
    try {
      const { rows: rawRows } = req.body as { rows?: unknown };
      if (!Array.isArray(rawRows) || rawRows.length === 0) {
        return res.status(400).json({ error: "rows must be a non-empty array" });
      }
      if (rawRows.length > BULK_MAX_ROWS) {
        return res.status(400).json({ error: `rows is limited to ${BULK_MAX_ROWS} per request` });
      }

      type BulkRow = {
        account_id: number; category_id?: number | null; date: string; description?: string;
        amount_fx: number; exchange_rate?: number; type: TransactionType; tag_ids?: number[];
      };
      const rows = rawRows as BulkRow[];
      for (const [i, r] of rows.entries()) {
        if (!r || typeof r !== "object") return res.status(400).json({ error: `row ${i}: must be an object` });
        if (r.type !== "debit" && r.type !== "credit") return res.status(400).json({ error: `row ${i}: type must be debit or credit` });
        if (!isValidDate(r.date)) return res.status(400).json({ error: `row ${i}: date must be a real YYYY-MM-DD date` });
        if (!validPositiveNumber(r.amount_fx)) return res.status(400).json({ error: `row ${i}: amount_fx must be a positive number` });
        if (r.exchange_rate !== undefined && !validPositiveNumber(r.exchange_rate, 1e9)) return res.status(400).json({ error: `row ${i}: exchange_rate must be a positive number` });
        if (r.description !== undefined && (typeof r.description !== "string" || r.description.length > 10_000)) return res.status(400).json({ error: `row ${i}: description is too long` });
        if (!Number.isInteger(r.account_id)) return res.status(400).json({ error: `row ${i}: account_id is required` });
        if (r.category_id != null && !Number.isInteger(r.category_id)) return res.status(400).json({ error: `row ${i}: category_id must be an integer` });
        if (r.tag_ids !== undefined && (
          !Array.isArray(r.tag_ids) || r.tag_ids.length > 100 ||
          !r.tag_ids.every((id) => Number.isInteger(id) && id > 0)
        )) return res.status(400).json({ error: `row ${i}: tag_ids must be an array of at most 100 positive integers` });
      }

      // Every referenced id must exist -- reject the whole
      // batch rather than silently mis-filing rows.
      const accountIds = [...new Set(rows.map((r) => r.account_id))];
      const ownedAccounts = await db.select({ id: accounts.id }).from(accounts)
        .where(and(inArray(accounts.id, accountIds)));
      if (ownedAccounts.length !== accountIds.length) {
        return res.status(400).json({ error: "one or more account_id values do not exist" });
      }

      const categoryIds = [...new Set(rows.flatMap((r) => (r.category_id != null ? [r.category_id] : [])))];
      const ownedCats = categoryIds.length
        ? await db.select({ id: categories.id, name: categories.name, kind: categories.kind }).from(categories)
            .where(and(inArray(categories.id, categoryIds)))
        : [];
      if (ownedCats.length !== categoryIds.length) {
        return res.status(400).json({ error: "one or more category_id values do not exist" });
      }
      const catById = new Map(ownedCats.map((c) => [c.id, c]));
      for (const [i, r] of rows.entries()) {
        const cat = r.category_id != null ? catById.get(r.category_id) : undefined;
        if (cat?.kind === "income" && r.type === "debit") {
          return res.status(400).json({ error: `row ${i}: Category "${cat.name}" is an income category and can only be used on credit (money-in) transactions.` });
        }
      }

      const tagIds = [...new Set(rows.flatMap((r) => r.tag_ids ?? []))];
      const ownedTags = tagIds.length
        ? await db.select({ id: tags.id }).from(tags)
            .where(and(inArray(tags.id, tagIds)))
        : [];
      if (ownedTags.length !== tagIds.length) {
        return res.status(400).json({ error: "one or more tag_ids values do not exist" });
      }

      const values = rows.map((r) => {
        const amountFx = assertStorableCents(toCents(r.amount_fx), "amount_fx");
        const rate = r.exchange_rate ?? 1;
        return {
          account_id: r.account_id,
          category_id: r.category_id ?? null,
          date: r.date,
          description: r.description ?? "",
          amount_fx: amountFx,
          exchange_rate: rate,
          // Derived server-side (cents) -- never trust a client amount_usd.
          amount_usd: deriveUsdCents(amountFx, rate),
          type: r.type,
        };
      });

      const created = await runTransaction(db, async (tx) => {
        const inserted = await tx.insert(transactions).values(values).returning();
        const tagLinks = inserted.flatMap((row, i) =>
          [...new Set(rows[i].tag_ids ?? [])].map((tid) => ({ transaction_id: row.id, tag_id: tid })));
        if (tagLinks.length > 0) await tx.insert(transactionTags).values(tagLinks);

        // One canonical recompute per touched account, then the sync hook.
        recomputeAccounts(tx, inserted.map((r) => r.account_id));
        for (const row of inserted) recordChange({ entity: "transaction", entityUuid: row.uuid, op: "upsert" });
        return inserted;
      });

      res.status(201).json({ created: created.length });
    } catch (err) {
      sendError(res, err, "Failed to create transactions");
    }
  });

  // POST /api/transactions/import-budget-app
  router.post("/import-budget-app", async (req, res) => {
    try {
      const { csv_text } = req.body as { csv_text?: unknown };
      if (typeof csv_text !== "string" || csv_text.length === 0) {
        return res.status(400).json({ error: "csv_text is required" });
      }
      if (csv_text.length > 10_000_000) return res.status(413).json({ error: "CSV is too large" });

      const lines = csv_text.split("\n");
      const headerIdx = lines.findIndex(l => l.trim().startsWith("date,"));
      if (headerIdx === -1) return res.status(400).json({ error: "Could not find budget-app header row" });
      const csvBody = lines.slice(headerIdx).join("\n");

      const records: Record<string, string>[] = parse(csvBody, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
      });
      if (records.length > 10_000) return res.status(400).json({ error: "CSV is limited to 10,000 rows" });

      const allAccounts = await db.select({ id: accounts.id, name: accounts.name, exchange_rate: accounts.exchange_rate }).from(accounts)
        .where(undefined);
      const allCats = await db.select({ id: categories.id, name: categories.name, parent_id: categories.parent_id, kind: categories.kind }).from(categories)
        .where(undefined);

      const accountMap = buildBudgetAppAccountMap(allAccounts, budgetAppMapping);
      const categoryMap = buildBudgetAppCategoryMap(allCats, budgetAppMapping);

      type PendingRow = { row: typeof transactions.$inferInsert; accountId: number };
      const pendingUnits: PendingRow[][] = [];
      const unmapped: string[] = [];
      const accountRate = new Map(allAccounts.map((account) => [account.id, account.exchange_rate]));
      const categoryKind = new Map(allCats.map((category) => [category.id, category.kind]));

      for (const r of records) {
        const hasOutcome = !!r.outcomeAccountName && !!r.outcome;
        const hasIncome  = !!r.incomeAccountName  && !!r.income;
        const description = r.comment || r.payee || "";
        const date = r.date;
        const categoryId = r.categoryName ? (categoryMap[r.categoryName] ?? null) : null;

        if (!hasOutcome && !hasIncome) continue;
        if (!isValidDate(date)) return res.status(400).json({ error: `Invalid date: ${date || "(empty)"}` });

        if (hasOutcome && hasIncome) {
          const outId = accountMap[r.outcomeAccountName];
          const inId  = accountMap[r.incomeAccountName];
          if (!outId) { unmapped.push(`account:${r.outcomeAccountName}`); continue; }
          if (!inId)  { unmapped.push(`account:${r.incomeAccountName}`);  continue; }
          if (outId === inId) {
            return res.status(400).json({ error: `Transfer on ${date} must use two different accounts` });
          }
          const parsedOut = parseBudgetAppAmount(r.outcome);
          const parsedIn = parseBudgetAppAmount(r.income);
          if (parsedOut === null || parsedIn === null) return res.status(400).json({ error: `Invalid transfer amount on ${date}` });
          const amt = assertStorableCents(toCents(parsedOut), "outcome amount");
          const amt2 = assertStorableCents(toCents(parsedIn), "income amount");
          const outRate = accountRate.get(outId) ?? 1;
          const inRate = accountRate.get(inId) ?? 1;
          const usd = deriveUsdCents(amt, outRate);
          const groupId = randomUUID();
          pendingUnits.push([
            { row: { account_id: outId, date, description, amount_fx: amt, exchange_rate: outRate, amount_usd: usd, type: "transfer", category_id: null, transfer_group_id: groupId, transfer_direction: "out" }, accountId: outId },
            { row: { account_id: inId, date, description, amount_fx: amt2, exchange_rate: inRate, amount_usd: usd, type: "transfer", category_id: null, transfer_group_id: groupId, transfer_direction: "in" }, accountId: inId },
          ]);
        } else if (hasOutcome) {
          const accId = accountMap[r.outcomeAccountName];
          if (!accId) { unmapped.push(`account:${r.outcomeAccountName}`); continue; }
          if (r.categoryName && categoryId === null) {
            unmapped.push(`category:${r.categoryName}`);
            continue;
          }
          if (categoryId !== null && categoryKind.get(categoryId) === "income") {
            return res.status(400).json({ error: `Category "${r.categoryName}" is an income category and can only be used on credit (money-in) transactions.` });
          }
          const parsed = parseBudgetAppAmount(r.outcome);
          if (parsed === null) return res.status(400).json({ error: `Invalid outcome amount on ${date}` });
          const amt = assertStorableCents(toCents(parsed), "outcome amount");
          const rate = accountRate.get(accId) ?? 1;
          pendingUnits.push([{ row: { account_id: accId, date, description, amount_fx: amt, exchange_rate: rate, amount_usd: deriveUsdCents(amt, rate), type: "debit", category_id: categoryId }, accountId: accId }]);
        } else {
          const accId = accountMap[r.incomeAccountName];
          if (!accId) { unmapped.push(`account:${r.incomeAccountName}`); continue; }
          if (r.categoryName && categoryId === null) {
            unmapped.push(`category:${r.categoryName}`);
            continue;
          }
          const parsed = parseBudgetAppAmount(r.income);
          if (parsed === null) return res.status(400).json({ error: `Invalid income amount on ${date}` });
          const amt = assertStorableCents(toCents(parsed), "income amount");
          const rate = accountRate.get(accId) ?? 1;
          pendingUnits.push([{ row: { account_id: accId, date, description, amount_fx: amt, exchange_rate: rate, amount_usd: deriveUsdCents(amt, rate), type: "credit", category_id: categoryId }, accountId: accId }]);
        }
      }

      let toInsert = pendingUnits.flat();
      let dupSkipped = 0;
      if (pendingUnits.length > 0) {
        const involvedAccIds = [...new Set(toInsert.map(p => p.accountId))];
        const existing = await db
          .select({
            account_id: transactions.account_id, date: transactions.date,
            amount_fx: transactions.amount_fx, type: transactions.type,
            description: transactions.description, transfer_direction: transactions.transfer_direction,
          })
          .from(transactions)
          .where(and(inArray(transactions.account_id, involvedAccIds)));
        const key = (row: {
          account_id: number; date: string; amount_fx: number; type: TransactionType;
          description?: string | null; transfer_direction?: string | null;
        }) =>
          `${row.account_id}|${row.date}|${row.amount_fx}|${row.type}|${row.transfer_direction ?? ""}|${(row.description ?? "").normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase("en-US")}`;
        const seen = new Set(existing.map(key));
        const uniqueUnits: PendingRow[][] = [];
        for (const unit of pendingUnits) {
          // Treat a transfer as one unit: if either leg already exists, skip both.
          if (unit.some((pending) => seen.has(key(pending.row)))) {
            dupSkipped += unit.length;
            continue;
          }
          uniqueUnits.push(unit);
          for (const pending of unit) seen.add(key(pending.row));
        }
        toInsert = uniqueUnits.flat();
      }

      // One transaction: a mid-import failure must not leave rows without
      // their balance updates (or vice versa).
      if (toInsert.length > 0) {
        await runTransaction(db, async (tx) => {
          const inserted = await tx.insert(transactions).values(toInsert.map(p => p.row)).returning();
          recomputeAccounts(tx, inserted.map((r) => r.account_id));
          for (const row of inserted) recordChange({ entity: "transaction", entityUuid: row.uuid, op: "upsert" });
        });
      }
      res.json({ imported: toInsert.length, skipped: dupSkipped, unmapped: [...new Set(unmapped)] });
    } catch (err) {
      sendError(res, err, "Failed to import budget-app CSV");
    }
  });

  // POST /api/transactions/transfer
  router.post("/transfer", async (req, res) => {
    try {
      const { from_account_id, to_account_id, date, description, amount_fx } = req.body as {
        from_account_id: number; to_account_id: number; date: string; description: string; amount_fx: number;
      };
      if (!Number.isInteger(from_account_id) || from_account_id <= 0 || !Number.isInteger(to_account_id) || to_account_id <= 0) {
        return res.status(400).json({ error: "account ids must be positive integers" });
      }
      if (!isValidDate(date)) return res.status(400).json({ error: "date must be a real calendar date in YYYY-MM-DD format" });
      if (typeof description !== "string" || description.length > 10_000) return res.status(400).json({ error: "description is too long" });
      if (!validPositiveNumber(amount_fx)) {
        return res.status(400).json({ error: "amount_fx must be a positive number" });
      }
      if (from_account_id === to_account_id) {
        return res.status(400).json({ error: "from_account_id and to_account_id must differ" });
      }
      const fromAccount = await transferAccount(from_account_id);
      const toAccount = await transferAccount(to_account_id);
      if (!fromAccount || !toAccount) {
        return res.status(400).json({ error: "account not found" });
      }
      const amount = transferAmounts(amount_fx, fromAccount.exchange_rate, toAccount.exchange_rate);
      const groupId = randomUUID(); // links the two legs -- no heuristic re-pairing
      const rows = await runTransaction(db, async (tx) => {
        const legs = await tx.insert(transactions).values([
          { account_id: from_account_id, date, description, amount_fx: amount.outFx, exchange_rate: fromAccount.exchange_rate, amount_usd: amount.usd, type: "transfer" as TransactionType, transfer_group_id: groupId, transfer_direction: "out" },
          { account_id: to_account_id, date, description, amount_fx: amount.inFx, exchange_rate: toAccount.exchange_rate, amount_usd: amount.usd, type: "transfer" as TransactionType, transfer_group_id: groupId, transfer_direction: "in" },
        ]).returning();
        recomputeAccounts(tx, [from_account_id, to_account_id]);
        for (const leg of legs) recordChange({ entity: "transaction", entityUuid: leg.uuid, op: "upsert" });
        return legs;
      });
      res.status(201).json(rows.map(r => ({ ...txToApi(r), tags: [] })));
    } catch (err) {
      sendError(res, err, "Failed to create transfer");
    }
  });

  // PATCH /api/transactions/transfer/:groupId -- replace both legs as one unit.
  router.patch("/transfer/:groupId", async (req, res) => {
    try {
      const groupId = req.params.groupId;
      if (!groupId || groupId.length > 64) return res.status(400).json({ error: "invalid transfer group" });
      const { from_account_id, to_account_id, date, description, amount_fx } = req.body as {
        from_account_id: number; to_account_id: number; date: string; description: string; amount_fx: number;
      };
      if (!Number.isInteger(from_account_id) || from_account_id <= 0 || !Number.isInteger(to_account_id) || to_account_id <= 0) {
        return res.status(400).json({ error: "account ids must be positive integers" });
      }
      if (from_account_id === to_account_id) return res.status(400).json({ error: "accounts must differ" });
      if (!isValidDate(date)) return res.status(400).json({ error: "date must be a real calendar date in YYYY-MM-DD format" });
      if (typeof description !== "string" || description.length > 10_000) return res.status(400).json({ error: "description is too long" });
      if (!validPositiveNumber(amount_fx)) return res.status(400).json({ error: "amount_fx must be a positive number" });
      const fromAccount = await transferAccount(from_account_id);
      const toAccount = await transferAccount(to_account_id);
      if (!fromAccount || !toAccount) return res.status(400).json({ error: "account not found" });
      const amount = transferAmounts(amount_fx, fromAccount.exchange_rate, toAccount.exchange_rate);

      const rows = await runTransaction(db, async (tx) => {
        const existing = await tx.select().from(transactions)
          .where(eq(transactions.transfer_group_id, groupId));
        if (existing.length !== 2 || !existing.some((row) => row.transfer_direction === "out") || !existing.some((row) => row.transfer_direction === "in")) {
          throw Object.assign(new Error("Linked transfer is incomplete and cannot be edited safely"), { status: 409 });
        }
        const out = existing.find((row) => row.transfer_direction === "out")!;
        const incoming = existing.find((row) => row.transfer_direction === "in")!;
        const updatedAt = new Date().toISOString();
        const [updatedOut] = await tx.update(transactions).set({
          account_id: from_account_id, category_id: null, date, description,
          amount_fx: amount.outFx, exchange_rate: fromAccount.exchange_rate,
          amount_usd: amount.usd, type: "transfer", transfer_direction: "out",
          exclude_from_reports: false, updated_at: updatedAt,
        }).where(eq(transactions.id, out.id)).returning();
        const [updatedIn] = await tx.update(transactions).set({
          account_id: to_account_id, category_id: null, date, description,
          amount_fx: amount.inFx, exchange_rate: toAccount.exchange_rate,
          amount_usd: amount.usd, type: "transfer", transfer_direction: "in",
          exclude_from_reports: false, updated_at: updatedAt,
        }).where(eq(transactions.id, incoming.id)).returning();
        recomputeAccounts(tx, [out.account_id, incoming.account_id, from_account_id, to_account_id]);
        recordChange({ entity: "transaction", entityUuid: updatedOut.uuid, op: "upsert" });
        recordChange({ entity: "transaction", entityUuid: updatedIn.uuid, op: "upsert" });
        return [updatedOut, updatedIn];
      });
      res.json(rows.map((row) => ({ ...txToApi(row), tags: [] })));
    } catch (err) {
      sendError(res, err, "Failed to update transfer");
    }
  });

  // POST /api/transactions -- single manual entry
  router.post("/", async (req, res) => {
    try {
      const body = req.body as typeof transactions.$inferInsert;
      if (body.type !== "debit" && body.type !== "credit") {
        return res.status(400).json({ error: "type must be debit or credit; use the linked transfer endpoint for transfers" });
      }
      const validationError = validateTransactionBody(body as unknown as Record<string, unknown>);
      if (validationError) return res.status(400).json({ error: validationError });
      if (!(await ownsAccount(body.account_id))) return res.status(400).json({ error: "account not found" });
      if (!(await ownsCategory(body.category_id))) return res.status(400).json({ error: "category not found" });
      const violation = await incomeViolation(body.category_id, body.type);
      if (violation) return res.status(400).json({ error: violation });
      const amountFx = assertStorableCents(toCents(body.amount_fx), "amount_fx");
      const rate = body.exchange_rate ?? 1;
      // amount_usd is derived server-side (cents) from amount_fx × rate -- never
      // trust the client-supplied value (data-integrity guard).
      const amountUsd = deriveUsdCents(amountFx, rate);
      const row = await runTransaction(db, async (tx) => {
        const [inserted] = await tx.insert(transactions).values({
          account_id: body.account_id,
          category_id: body.category_id ?? null,
          date: body.date,
          description: body.description ?? "",
          amount_fx: amountFx,
          exchange_rate: rate,
          amount_usd: amountUsd,
          type: body.type,
          exclude_from_reports: body.exclude_from_reports === true,
        }).returning();
        recomputeAccountBalance(tx, inserted.account_id);
        recordChange({ entity: "transaction", entityUuid: inserted.uuid, op: "upsert" });
        return inserted;
      });
      res.status(201).json({ ...txToApi(row), tags: [] });
    } catch (err) {
      sendError(res, err, "Failed to create transaction");
    }
  });

  // PATCH /api/transactions/:id
  router.patch("/:id", async (req, res) => {
    try {
      const id = parsePositiveId(req.params.id);
      if (id === null) return res.status(400).json({ error: "id must be a positive integer" });
      const { account_id, category_id, date, description, amount_fx, exchange_rate, type, exclude_from_reports } = req.body;
      if (type !== "debit" && type !== "credit") {
        return res.status(400).json({ error: "type must be debit or credit; use the linked transfer endpoint for transfers" });
      }
      const validationError = validateTransactionBody(req.body as Record<string, unknown>);
      if (validationError) return res.status(400).json({ error: validationError });

      if (!(await ownsAccount(account_id))) return res.status(400).json({ error: "account not found" });
      if (!(await ownsCategory(category_id ?? null))) return res.status(400).json({ error: "category not found" });
      const violation = await incomeViolation(category_id ?? null, type);
      if (violation) return res.status(400).json({ error: violation });

      const amountFx = assertStorableCents(toCents(amount_fx), "amount_fx");
      const rate = exchange_rate ?? 1;
      // amount_usd derived server-side (cents) -- never trust the client value.
      const amountUsd = deriveUsdCents(amountFx, rate);
      // The old per-transition delta matrix collapses to: recompute every
      // touched account (frozen-delta model).
      const row = await runTransaction(db, async (tx) => {
        // This read belongs under the same serialized write lock as the update.
        // Otherwise two moves can both observe the same old account and the
        // later request may fail to recompute the intermediate account.
        const [current] = await tx.select().from(transactions)
          .where(and(eq(transactions.id, id)));
        if (!current) throw Object.assign(new Error("Transaction not found"), { status: 404 });
        if (current.type === "transfer") {
          throw Object.assign(new Error("Linked transfers must be edited as a pair"), { status: 409 });
        }
        const [updated] = await tx
          .update(transactions)
          .set({ account_id, category_id: category_id ?? null, date, description, amount_fx: amountFx, exchange_rate: rate, amount_usd: amountUsd, type, exclude_from_reports, updated_at: new Date().toISOString() })
          .where(and(eq(transactions.id, id)))
          .returning();
        recomputeAccounts(tx, [current.account_id, updated.account_id]);
        recordChange({ entity: "transaction", entityUuid: updated.uuid, op: "upsert" });
        return updated;
      });

      res.json({ ...txToApi(row), tags: [] });
    } catch (err) {
      sendError(res, err, "Failed to update transaction");
    }
  });

  // DELETE /api/transactions/:id
  router.delete("/:id", async (req, res) => {
    try {
      const id = parsePositiveId(req.params.id);
      if (id === null) return res.status(400).json({ error: "id must be a positive integer" });
      await runTransaction(db, async (t) => {
        // Discover the row only after acquiring the write queue so an
        // overlapping move cannot make us recompute its former account.
        const [current] = await t.select().from(transactions)
          .where(and(eq(transactions.id, id)));
        if (!current) throw Object.assign(new Error("Transaction not found"), { status: 404 });
        if (current.type === "transfer") {
          if (!current.transfer_group_id) {
            throw Object.assign(new Error("Legacy unpaired transfer cannot be deleted safely"), { status: 409 });
          }
          const legs = await t.select().from(transactions)
            .where(eq(transactions.transfer_group_id, current.transfer_group_id));
          if (legs.length !== 2) {
            throw Object.assign(new Error("Linked transfer is incomplete and cannot be deleted safely"), { status: 409 });
          }
          await t.delete(transactions).where(eq(transactions.transfer_group_id, current.transfer_group_id));
          recomputeAccounts(t, legs.map((leg) => leg.account_id));
          for (const leg of legs) recordChange({ entity: "transaction", entityUuid: leg.uuid, op: "delete" });
        } else {
          await t.delete(transactions).where(and(eq(transactions.id, id)));
          recomputeAccountBalance(t, current.account_id);
          recordChange({ entity: "transaction", entityUuid: current.uuid, op: "delete" });
        }
      });
      res.status(204).send();
    } catch (err) {
      sendError(res, err, "Failed to delete transaction");
    }
  });

  return router;
}

export default createTransactionsRouter;
