import { Router } from "express";
import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import type { DrizzleDB } from "../db/types.js";
import { runTransaction } from "../db/tx.js";
import { accounts, accountAdjustments, transactions } from "../db/schema.js";
import { deriveMarketValueCents, fromCents, toCents } from "../lib/finance.js";
import { recomputeAccountBalance } from "../lib/recompute.js";
import { recordChange } from "../lib/ledgerHooks.js";
import { parsePositiveId, sendError } from "../lib/validation.js";

type AccountRow = typeof accounts.$inferSelect & {
  has_recent_adjustment?: number | boolean;
};

// Money is stored as integer cents; the JSON API speaks dollars. Convert money
// fields to dollars on the way out. balance_usd is derived (balance × rate),
// matching the historical behaviour.
function enrich(account: AccountRow) {
  const rest = account;
  const base = {
    ...rest,
    balance: fromCents(rest.balance),
    balance_usd: fromCents(rest.balance_usd),
    current_price_usd: rest.current_price_usd == null ? null : fromCents(rest.current_price_usd),
    is_default: Boolean(rest.is_default),
    is_active: Boolean(rest.is_active),
    exclude_from_reports: Boolean(rest.exclude_from_reports),
    has_recent_adjustment: Boolean(rest.has_recent_adjustment ?? false),
  };
  if (rest.account_type === "RSU" && rest.shares_quantity != null && rest.current_price_usd != null) {
    return { ...base, market_value: fromCents(deriveMarketValueCents(rest.shares_quantity, rest.current_price_usd)) };
  }
  return { ...base, market_value: null };
}

// Convert the dollar-denominated money fields of an inbound account body to
// integer cents. exchange_rate and shares_quantity are genuine fractions and
// are left untouched.
function accountMoneyToCents<T extends Record<string, unknown>>(body: T): T {
  const out: Record<string, unknown> = { ...body };
  if (typeof out.balance === "number") out.balance = toCents(out.balance);
  if (typeof out.balance_usd === "number") out.balance_usd = toCents(out.balance_usd);
  if (typeof out.current_price_usd === "number") out.current_price_usd = toCents(out.current_price_usd);
  return out as T;
}

// Whitelist of client-settable account columns. Prevents request bodies from
// assigning server-owned fields such as ids, UUIDs, and timestamps.
const ACCOUNT_WRITABLE = [
  "name", "account_type", "base_currency", "liquidity_type",
  "balance", "exchange_rate", "balance_usd",
  "ticker", "shares_quantity", "current_price_usd",
  "sort_order", "notes", "is_default", "is_active", "exclude_from_reports",
] as const;

const ACCOUNT_TYPES = new Set(["Cash", "Checking", "Savings", "CC", "Investment", "Roth401k", "401k", "HSA", "Asset-NonLiquid", "RSU"]);
const LIQUIDITY_TYPES = new Set(["Liquid", "Invested", "Locked"]);
const MONEY_FIELDS = ["balance", "balance_usd", "current_price_usd"] as const;
const FRACTION_FIELDS = ["exchange_rate", "shares_quantity"] as const;

function validateAccountBody(body: unknown, creating: boolean): string | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return "account must be an object";
  const row = body as Record<string, unknown>;
  if (creating || row.name !== undefined) {
    if (typeof row.name !== "string" || row.name.trim().length === 0 || row.name.length > 200) {
      return "name must be between 1 and 200 characters";
    }
  }
  if (creating || row.account_type !== undefined) {
    if (typeof row.account_type !== "string" || !ACCOUNT_TYPES.has(row.account_type)) return "invalid account_type";
  }
  if (creating || row.liquidity_type !== undefined) {
    if (typeof row.liquidity_type !== "string" || !LIQUIDITY_TYPES.has(row.liquidity_type)) return "invalid liquidity_type";
  }
  if (row.base_currency !== undefined && (typeof row.base_currency !== "string" || !/^[A-Z]{3}$/.test(row.base_currency))) {
    return "base_currency must be a three-letter uppercase code";
  }
  for (const field of MONEY_FIELDS) {
    const value = row[field];
    if (value !== undefined && value !== null && (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 1e12)) {
      return `${field} must be a finite number`;
    }
  }
  if (row.current_price_usd !== undefined && row.current_price_usd !== null && (row.current_price_usd as number) < 0) {
    return "current_price_usd must be non-negative";
  }
  for (const field of FRACTION_FIELDS) {
    const value = row[field];
    if (value !== undefined && value !== null && (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1e9)) {
      return `${field} must be a finite non-negative number`;
    }
  }
  if (row.exchange_rate !== undefined && (typeof row.exchange_rate !== "number" || row.exchange_rate <= 0)) {
    return "exchange_rate must be positive";
  }
  if (row.ticker !== undefined && row.ticker !== null && (typeof row.ticker !== "string" || row.ticker.length > 32)) return "ticker is too long";
  if (row.notes !== undefined && row.notes !== null && (typeof row.notes !== "string" || row.notes.length > 10_000)) return "notes are too long";
  if (row.sort_order !== undefined && row.sort_order !== null && (!Number.isInteger(row.sort_order) || Math.abs(row.sort_order as number) > 1_000_000)) return "sort_order must be an integer";
  for (const field of ["is_default", "is_active", "exclude_from_reports"] as const) {
    if (row[field] !== undefined && typeof row[field] !== "boolean") return `${field} must be a boolean`;
  }
  return null;
}

function pickAccountFields(body: Record<string, unknown>): Partial<typeof accounts.$inferInsert> {
  const out: Record<string, unknown> = {};
  for (const k of ACCOUNT_WRITABLE) if (body[k] !== undefined) out[k] = body[k];
  return out as Partial<typeof accounts.$inferInsert>;
}

function validateRsuMarketValue(row: {
  account_type?: string;
  shares_quantity?: number | null;
  current_price_usd?: number | null;
}): string | null {
  if (row.account_type !== "RSU" || row.shares_quantity == null || row.current_price_usd == null) return null;
  try {
    deriveMarketValueCents(row.shares_quantity, row.current_price_usd);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : "RSU market value is outside the supported money range";
  }
}

async function clearOtherDefaults(db: DrizzleDB, exceptId: number) {
  const cleared = await db.update(accounts)
    .set({ is_default: false, updated_at: new Date().toISOString() })
    .where(and(ne(accounts.id, exceptId), eq(accounts.is_default, true)))
    .returning({ uuid: accounts.uuid });
  for (const row of cleared) {
    recordChange({ entity: "account", entityUuid: row.uuid, op: "upsert" });
  }
}

export function createAccountsRouter(db: DrizzleDB) {
  const router = Router();

  router.get("/", async (req, res) => {
    try {
      const rows = await db
        .select({
          id: accounts.id,
          uuid: accounts.uuid,
          name: accounts.name,
          account_type: accounts.account_type,
          base_currency: accounts.base_currency,
          liquidity_type: accounts.liquidity_type,
          balance: accounts.balance,
          exchange_rate: accounts.exchange_rate,
          balance_usd: accounts.balance_usd,
          ticker: accounts.ticker,
          shares_quantity: accounts.shares_quantity,
          current_price_usd: accounts.current_price_usd,
          sort_order: accounts.sort_order,
          notes: accounts.notes,
          is_default: accounts.is_default,
          is_active: accounts.is_active,
          exclude_from_reports: accounts.exclude_from_reports,
          created_at: accounts.created_at,
          updated_at: accounts.updated_at,
          // The correlated column is qualified BY HAND: drizzle's sqlite
          // dialect renders ${accounts.id} as bare "id" inside a subquery,
          // which SQLite then resolves against aa (aa.account_id = aa.id) --
          // silently matching adjustment ids instead of accounts.
          has_recent_adjustment: sql<boolean>`EXISTS (
            SELECT 1 FROM account_adjustments aa
            WHERE aa.account_id = accounts.id
              AND aa.created_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 days')
              AND aa.reason NOT LIKE 'Opening balance%'
          )`,
        })
        .from(accounts)
        .where(undefined)
        .orderBy(sql`${accounts.sort_order} ASC NULLS LAST`, asc(accounts.id));
      res.json(rows.map(enrich));
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to fetch accounts" });
    }
  });

  router.post("/", async (req, res) => {
    try {
      const validationError = validateAccountBody(req.body, true);
      if (validationError) return res.status(400).json({ error: validationError });
      const body = pickAccountFields(accountMoneyToCents(req.body as Record<string, unknown>));
      body.name = (body.name as string).trim();
      const marketValueError = validateRsuMarketValue(body);
      if (marketValueError) return res.status(400).json({ error: marketValueError });
      // Frozen-delta model: a non-zero opening balance becomes an "Opening
      // balance" adjustment row so the canonical recompute reproduces it on
      // every replica. RSU accounts never carry a balance (worth is shares x
      // price); a legacy client submitting one gets it normalized to 0.
      const isRSU = body.account_type === "RSU";
      const openingBalance = !isRSU && typeof body.balance === "number" ? body.balance : 0;
      const row = await runTransaction(db, async (tx) => {
        const [inserted] = await tx.insert(accounts)
          .values({ ...body, balance: 0, balance_usd: 0 } as typeof accounts.$inferInsert)
          .returning();
        if (openingBalance !== 0) {
          const [adj] = await tx.insert(accountAdjustments).values({
            account_id: inserted.id, old_balance: 0, new_balance: openingBalance, reason: "Opening balance",
          }).returning();
          recordChange({ entity: "account_adjustment", entityUuid: adj.uuid, op: "upsert" });
        }
        if (inserted.is_default) await clearOtherDefaults(tx, inserted.id);
        recomputeAccountBalance(tx, inserted.id);
        recordChange({ entity: "account", entityUuid: inserted.uuid, op: "upsert" });
        const [fresh] = await tx.select().from(accounts).where(and(eq(accounts.id, inserted.id)));
        return fresh;
      });
      res.status(201).json(enrich(row));
    } catch (err) {
      sendError(res, err, "Failed to create account");
    }
  });

  // Must be registered before /:id to avoid "reorder" being treated as an id
  router.patch("/reorder", async (req, res) => {
    try {
      const order = (req.body as { order?: unknown })?.order;
      if (!Array.isArray(order) || order.length > 2_000 || !order.every((item) =>
        typeof item === "object" && item !== null &&
        Number.isInteger((item as { id?: unknown }).id) && ((item as { id: number }).id > 0) &&
        Number.isInteger((item as { sort_order?: unknown }).sort_order) &&
        Math.abs((item as { sort_order: number }).sort_order) <= 1_000_000
      )) {
        return res.status(400).json({ error: "order must be an array of valid id and sort_order pairs" });
      }
      const ids = order.map(({ id }) => id);
      if (new Set(ids).size !== ids.length) {
        return res.status(400).json({ error: "order must not contain duplicate account ids" });
      }
      if (ids.length > 0) {
        const existing = await db.select({ id: accounts.id }).from(accounts).where(inArray(accounts.id, ids));
        if (existing.length !== ids.length) {
          return res.status(400).json({ error: "order contains an account that does not exist" });
        }
      }
      // One transaction so a drag never commits a half-applied ordering.
      await runTransaction(db, async (tx) => {
        for (const { id, sort_order } of order) {
          const [row] = await tx.update(accounts).set({ sort_order })
            .where(and(eq(accounts.id, id))).returning();
          if (row) recordChange({ entity: "account", entityUuid: row.uuid, op: "upsert" });
        }
      });
      res.json({ ok: true });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to reorder accounts" });
    }
  });

  // GET /api/accounts/:id/verify -- compare stored balance vs ledger sum
  router.get("/:id/verify", async (req, res) => {
    try {
      const id = parsePositiveId(req.params.id);
      if (id === null) return res.status(400).json({ error: "id must be a positive integer" });
      const [account] = await db.select().from(accounts)
        .where(and(eq(accounts.id, id)));
      if (!account) return res.status(404).json({ error: "Account not found" });

      // Canonical frozen-delta recompute: contributions (with transfer
      // directions) plus adjustment deltas. Drift is 0 by construction; a
      // non-zero value means a write path bypassed the recompute invariant.
      const [result] = await db
        .select({
          computed: sql<number>`COALESCE(SUM(CASE
            WHEN ${transactions.type} = 'credit' THEN ${transactions.amount_fx}
            WHEN ${transactions.type} = 'debit' THEN -${transactions.amount_fx}
            WHEN ${transactions.transfer_direction} = 'out' THEN -${transactions.amount_fx}
            WHEN ${transactions.transfer_direction} = 'in' THEN ${transactions.amount_fx}
            ELSE 0 END), 0)`,
          count: sql<number>`COUNT(*)`,
        })
        .from(transactions)
        .where(and(eq(transactions.account_id, id)));
      const [adj] = await db
        .select({ c: sql<number>`COALESCE(SUM(${accountAdjustments.new_balance} - ${accountAdjustments.old_balance}), 0)` })
        .from(accountAdjustments)
        .where(and(eq(accountAdjustments.account_id, id)));

      const computedCents = Number(result.computed ?? 0) + Number(adj.c ?? 0);
      const storedCents = account.balance;
      const driftCents = computedCents - storedCents;

      res.json({
        stored_balance: fromCents(storedCents),
        computed_balance: fromCents(computedCents),
        drift: fromCents(driftCents),
        transaction_count: Number(result.count ?? 0),
        note: "Computed = canonical ledger recompute (transaction contributions + adjustment deltas). Drift of 0 means the stored balance matches the ledger exactly.",
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to verify account" });
    }
  });

  // GET /api/accounts/:id/adjustments -- audit log (balances surfaced in dollars)
  router.get("/:id/adjustments", async (req, res) => {
    try {
      const id = parsePositiveId(req.params.id);
      if (id === null) return res.status(400).json({ error: "id must be a positive integer" });
      const rows = await db
        .select()
        .from(accountAdjustments)
        .where(and(eq(accountAdjustments.account_id, id)))
        .orderBy(sql`${accountAdjustments.created_at} DESC`);
      res.json(rows.map((r) => ({ ...r, old_balance: fromCents(r.old_balance), new_balance: fromCents(r.new_balance) })));
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to fetch adjustments" });
    }
  });

  router.patch("/:id", async (req, res) => {
    try {
      const id = parsePositiveId(req.params.id);
      if (id === null) return res.status(400).json({ error: "id must be a positive integer" });
      const { reason, ...rawBody } = req.body as Record<string, unknown> & { reason?: string };
      const validationError = validateAccountBody(rawBody, false);
      if (validationError) return res.status(400).json({ error: validationError });
      // Whitelist client-settable fields so request bodies cannot assign ids,
      // timestamps, or other server-owned columns.
      const body: Partial<typeof accounts.$inferInsert> = {
        ...pickAccountFields(accountMoneyToCents(rawBody)),
        updated_at: new Date().toISOString(), // maintained server-side on every PATCH
      };
      if (typeof body.name === "string") body.name = body.name.trim();

      // Guard: a real balance change (different value) requires a reason and
      // becomes an adjustment row -- the frozen delta is what the canonical
      // recompute (and any sync replica) reproduces. RSU accounts are exempt:
      // their worth is shares × price (market_value) and their balance pins
      // to 0. balance/balance_usd are never assigned directly anymore.
      const { balance: requestedBalance, balance_usd: _ignoredUsd, ...fields } = body;
      void _ignoredUsd;
      const row = await runTransaction(db, async (tx) => {
        const [current] = await tx.select().from(accounts)
          .where(and(eq(accounts.id, id)));
        if (!current) throw Object.assign(new Error("Account not found"), { status: 404 });
        const marketValueError = validateRsuMarketValue({
          account_type: body.account_type ?? current.account_type,
          shares_quantity: body.shares_quantity === undefined ? current.shares_quantity : body.shares_quantity,
          current_price_usd: body.current_price_usd === undefined ? current.current_price_usd : body.current_price_usd,
        });
        if (marketValueError) throw Object.assign(new Error(marketValueError), { status: 400 });
        const nextIsRSU = (body.account_type ?? current.account_type) === "RSU";
        if (nextIsRSU && current.balance !== 0) {
          // RSU worth is shares x price, never a cash ledger balance. Record a
          // compensating adjustment instead of writing balance directly so
          // sync replicas reproduce the same zero balance on recompute.
          const [adj] = await tx.insert(accountAdjustments).values({
            account_id: id,
            old_balance: current.balance,
            new_balance: 0,
            reason: current.account_type === "RSU" ? "Normalized RSU balance" : "Converted account to RSU",
          }).returning();
          recordChange({ entity: "account_adjustment", entityUuid: adj.uuid, op: "upsert" });
        } else if (typeof requestedBalance === "number") {
          if (requestedBalance !== current.balance && !nextIsRSU) {
            const trimmedReason = (reason ?? "").trim();
            if (!trimmedReason) {
              throw Object.assign(new Error("reason is required when updating balance"), { status: 400 });
            }
            const [adj] = await tx.insert(accountAdjustments).values({
              account_id: id,
              old_balance: current.balance,
              new_balance: requestedBalance,
              reason: trimmedReason,
            }).returning();
            recordChange({ entity: "account_adjustment", entityUuid: adj.uuid, op: "upsert" });
          }
        }
        if (body.is_default === true) await clearOtherDefaults(tx, id);
        await tx.update(accounts).set(fields)
          .where(and(eq(accounts.id, id)));
        recomputeAccountBalance(tx, id);
        recordChange({ entity: "account", entityUuid: current.uuid, op: "upsert" });
        const [fresh] = await tx.select().from(accounts)
          .where(and(eq(accounts.id, id)));
        return fresh;
      });
      res.json(enrich(row));
    } catch (err) {
      sendError(res, err, "Failed to update account");
    }
  });

  router.delete("/:id", async (req, res) => {
    try {
      const id = parsePositiveId(req.params.id);
      if (id === null) return res.status(400).json({ error: "id must be a positive integer" });
      const deleted = await runTransaction(db, async (tx) => {
        const rows = await tx.delete(accounts)
          .where(and(eq(accounts.id, id)))
          .returning({ id: accounts.id, uuid: accounts.uuid });
        if (rows.length > 0) {
          // FK cascades removed transactions + adjustments; a replica applies
          // this tombstone and its identical local cascade reproduces them.
          recordChange({ entity: "account", entityUuid: rows[0].uuid, op: "delete" });
        }
        return rows;
      });
      if (deleted.length === 0) return res.status(404).json({ error: "Account not found" });
      res.status(204).send();
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to delete account" });
    }
  });

  return router;
}

export default createAccountsRouter;
