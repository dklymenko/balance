import { Router } from "express";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { DrizzleDB } from "../db/types.js";
import { runTransaction } from "../db/tx.js";
import {
  accounts, categories, tags, transactions, transactionTags,
  accountAdjustments, amazonOrders,
  type AccountType, type LiquidityType, type TransactionType, type CategoryKind,
} from "../db/schema.js";
import { fromCents } from "../lib/finance.js";
import { LOCAL_HOUSEHOLD_NAME } from "../lib/identity.js";
import { seedSampleData } from "../lib/sampleData.js";
import { recordChange } from "../lib/ledgerHooks.js";
import { recomputeAccountBalance } from "../lib/recompute.js";
import { errorStatus, sendError } from "../lib/validation.js";
import { ArchiveError as CoreArchiveError, validateArchive } from "@balance/core";

// The "Balance archive": one portable, versioned JSON that GET /export
// produces and POST /import consumes -- the interchange format for the
// desktop migration wizard and the local API. Money is integer cents in the
// archive; here that is also the storage
// convention, so no conversion happens. Integer row ids are included only so
// the importer can remap cross-references; stable UUIDs are preserved when an
// archive carries them so a restore keeps the same sync identities.

const ARCHIVE_FORMAT = "balance-archive";
const ARCHIVE_VERSION = 1;

const ARCHIVE_ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ACCOUNT_TYPES = new Set<string>([
  "Cash", "Checking", "Savings", "CC", "Investment", "Roth401k", "401k", "HSA",
  "Asset-NonLiquid", "RSU",
]);
const LIQUIDITY_TYPES = new Set<string>(["Liquid", "Invested", "Locked"]);
const TX_TYPES = new Set<string>(["debit", "credit", "transfer"]);
const CATEGORY_KINDS = new Set<string>(["income", "expense", "both"]);

// Generous per-table row caps so a malformed or hostile archive cannot make
// the importer chew through unbounded work (the JSON body itself is already
// capped by the express.json limit).
const MAX_ROWS: Record<string, number> = {
  accounts: 2_000,
  categories: 2_000,
  tags: 5_000,
  transactions: 200_000,
  account_adjustments: 20_000,
  transaction_tags: 400_000,
};
const MAX_STR = 10_000;

class ArchiveError extends Error {}
class ArchiveConflictError extends Error {}

function must(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new ArchiveError(msg);
}

function isCents(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v);
}

function isStr(v: unknown): v is string {
  return typeof v === "string" && v.length <= MAX_STR;
}

function optStr(v: unknown): string | null {
  return isStr(v) ? v : null;
}

function isArchiveRow(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function tableOf(archive: Record<string, unknown>, name: string): Record<string, unknown>[] {
  const raw = archive[name] ?? [];
  must(Array.isArray(raw), `${name} must be an array`);
  must(raw.length <= MAX_ROWS[name], `${name} exceeds the ${MAX_ROWS[name]} row limit`);
  raw.forEach((r) => must(isArchiveRow(r), `${name} contains a non-object entry`));
  return raw as Record<string, unknown>[];
}

// RFC-4180 cell encoding plus spreadsheet-formula neutralization for text that
// starts with a formula sigil (including leading whitespace/control bytes).
function csvCell(v: unknown): string {
  const raw = v == null ? "" : String(v);
  const s = typeof v === "string" && /^[\t\r +\-=@]/.test(raw) ? `'${raw}` : raw;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const csvRow = (cells: unknown[]) => cells.map(csvCell).join(",");

export function createDataRouter(db: DrizzleDB) {
  const router = Router();

  // GET /api/data/export -- full household snapshot as a Balance archive
  // (money in integer cents; internal row ids are kept only for reference
  // remapping). A faithful, re-importable
  // backup of every ledger table.
  router.get("/export", async (req, res) => {
    try {
      // A portable backup must describe one database instant. Without a read
      // transaction, an edit between the table queries could leave dangling
      // tag links or mismatched ledger rows in an otherwise successful file.
      const snapshot = await runTransaction(db, async (tx) => {
        const [acc, cats, tagRows, txs, adj] = await Promise.all([
          tx.select().from(accounts).where(undefined).orderBy(asc(accounts.id)),
          tx.select().from(categories).where(undefined).orderBy(asc(categories.id)),
          tx.select().from(tags).where(undefined).orderBy(asc(tags.id)),
          tx.select().from(transactions).where(undefined).orderBy(asc(transactions.id)),
          tx.select().from(accountAdjustments).where(undefined).orderBy(asc(accountAdjustments.id)),
        ]);
        const txIds = txs.map((t) => t.id);
        const txTags = txIds.length
          ? await tx.select().from(transactionTags).where(inArray(transactionTags.transaction_id, txIds))
          : [];
        return { acc, cats, tagRows, txs, adj, txTags };
      });

      res.setHeader("Content-Disposition", `attachment; filename="balance-archive-${new Date().toISOString().slice(0, 10)}.json"`);
      res.json({
        format: ARCHIVE_FORMAT,
        version: ARCHIVE_VERSION,
        exported_at: new Date().toISOString(),
        accounts: snapshot.acc,
        categories: snapshot.cats,
        tags: snapshot.tagRows,
        transactions: snapshot.txs,
        account_adjustments: snapshot.adj,
        transaction_tags: snapshot.txTags,
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to export data" });
    }
  });

  // POST /api/data/import -- restore a Balance archive into an EMPTY household
  // (v1 semantics: no merge). Admin-only. All-or-nothing: any malformed row
  // or dangling reference rolls the whole import back. Re-posting after a
  // successful import finds a non-empty household and returns 409 with
  // imported: 0, so a retried upload can never duplicate data.
  router.post("/import", async (req, res) => {
    try {
      const archive = validateArchive(req.body) as unknown as Record<string, unknown>;

      const counts = await runTransaction(db, async (tx) => {
        const [[hasAccount], [hasCategory], [hasTag], [hasTx]] = await Promise.all([
          tx.select({ id: accounts.id }).from(accounts).where(undefined).limit(1),
          tx.select({ id: categories.id }).from(categories).where(undefined).limit(1),
          tx.select({ id: tags.id }).from(tags).where(undefined).limit(1),
          tx.select({ id: transactions.id }).from(transactions).where(undefined).limit(1),
        ]);
        if (hasAccount || hasCategory || hasTag || hasTx) {
          throw new ArchiveConflictError(
            "Import requires an empty household; this household already contains data. Reset it first (Settings) to migrate into it.",
          );
        }
        const accRows = tableOf(archive, "accounts");
        const catRows = tableOf(archive, "categories");
        const tagRows = tableOf(archive, "tags");
        const txRows = tableOf(archive, "transactions");
        const adjRows = tableOf(archive, "account_adjustments");
        const linkRows = tableOf(archive, "transaction_tags");

        const accountIds = new Map<number, number>();
        const accountUuids: string[] = [];
        for (const a of accRows) {
          must(isCents(a.id), "accounts.id must be an integer");
          must(isStr(a.name) && a.name.length > 0, "accounts.name is required");
          must(typeof a.account_type === "string" && ACCOUNT_TYPES.has(a.account_type), "invalid accounts.account_type");
          must(typeof a.liquidity_type === "string" && LIQUIDITY_TYPES.has(a.liquidity_type), "invalid accounts.liquidity_type");
          must(isCents(a.balance) && isCents(a.balance_usd), "account balances must be integer cents");
          must(a.current_price_usd == null || isCents(a.current_price_usd), "accounts.current_price_usd must be integer cents or null");
          must(typeof a.exchange_rate === "number" && Number.isFinite(a.exchange_rate), "accounts.exchange_rate must be a number");
          must(a.shares_quantity == null || typeof a.shares_quantity === "number", "invalid accounts.shares_quantity");
          const [inserted] = await tx.insert(accounts).values({
            ...(isStr(a.uuid) && a.uuid.length > 0 ? { uuid: a.uuid } : {}),
            name: a.name,
            account_type: a.account_type as AccountType,
            base_currency: optStr(a.base_currency) ?? "USD",
            liquidity_type: a.liquidity_type as LiquidityType,
            balance: 0,
            exchange_rate: a.exchange_rate,
            balance_usd: 0,
            ticker: optStr(a.ticker),
            shares_quantity: typeof a.shares_quantity === "number" ? a.shares_quantity : null,
            current_price_usd: a.current_price_usd == null ? null : (a.current_price_usd as number),
            sort_order: isCents(a.sort_order) ? a.sort_order : null,
            notes: optStr(a.notes),
            is_default: a.is_default === true,
            is_active: a.is_active !== false,
            exclude_from_reports: a.exclude_from_reports === true,
            ...(isStr(a.created_at) ? { created_at: a.created_at } : {}),
            ...(isStr(a.updated_at) ? { updated_at: a.updated_at } : {}),
          }).returning({ id: accounts.id, uuid: accounts.uuid });
          accountIds.set(a.id, inserted.id);
          accountUuids.push(inserted.uuid);
        }

        // Categories are max one level deep, so insert top-level rows first
        // and children second, remapping parent_id through the first pass.
        const categoryIds = new Map<number, number>();
        const categoryUuids: string[] = [];
        const catValues = (c: Record<string, unknown>, parentId: number | null) => ({
          ...(isStr(c.uuid) && c.uuid.length > 0 ? { uuid: c.uuid } : {}),
          name: c.name as string,
          parent_id: parentId,
          kind: (typeof c.kind === "string" && CATEGORY_KINDS.has(c.kind) ? c.kind : "expense") as CategoryKind,
          ...(isStr(c.created_at) ? { created_at: c.created_at } : {}),
        });
        for (const c of catRows) {
          must(isCents(c.id), "categories.id must be an integer");
          must(isStr(c.name) && c.name.length > 0, "categories.name is required");
          must(c.parent_id == null || isCents(c.parent_id), "categories.parent_id must be an integer or null");
          if (c.parent_id != null) continue;
          const [inserted] = await tx.insert(categories).values(catValues(c, null)).returning({ id: categories.id, uuid: categories.uuid });
          categoryIds.set(c.id as number, inserted.id);
          categoryUuids.push(inserted.uuid);
        }
        for (const c of catRows) {
          if (c.parent_id == null) continue;
          const parentId = categoryIds.get(c.parent_id as number);
          must(parentId !== undefined, `categories.parent_id ${c.parent_id} does not resolve to a top-level category`);
          const [inserted] = await tx.insert(categories).values(catValues(c, parentId)).returning({ id: categories.id, uuid: categories.uuid });
          categoryIds.set(c.id as number, inserted.id);
          categoryUuids.push(inserted.uuid);
        }

        const tagIds = new Map<number, number>();
        const tagUuids: string[] = [];
        for (const t of tagRows) {
          must(isCents(t.id), "tags.id must be an integer");
          must(isStr(t.name) && t.name.length > 0, "tags.name is required");
          const [inserted] = await tx.insert(tags).values({
            ...(isStr(t.uuid) && t.uuid.length > 0 ? { uuid: t.uuid } : {}),
            name: t.name,
            ...(isStr(t.created_at) ? { created_at: t.created_at } : {}),
          }).returning({ id: tags.id, uuid: tags.uuid });
          tagIds.set(t.id, inserted.id);
          tagUuids.push(inserted.uuid);
        }

        const txIds = new Map<number, number>();
        const transactionUuids: string[] = [];
        for (const t of txRows) {
          must(isCents(t.id), "transactions.id must be an integer");
          const accountId = isCents(t.account_id) ? accountIds.get(t.account_id) : undefined;
          must(accountId !== undefined, `transactions.account_id ${t.account_id} does not resolve to an account`);
          let categoryId: number | null = null;
          if (t.category_id != null) {
            categoryId = (isCents(t.category_id) ? categoryIds.get(t.category_id) : undefined) ?? null;
            must(categoryId !== null, `transactions.category_id ${t.category_id} does not resolve to a category`);
          }
          must(isStr(t.date) && ARCHIVE_ISO_DATE_RE.test(t.date), "transactions.date must be YYYY-MM-DD");
          must(isCents(t.amount_fx) && isCents(t.amount_usd), "transaction amounts must be integer cents");
          must(typeof t.exchange_rate === "number" && Number.isFinite(t.exchange_rate), "transactions.exchange_rate must be a number");
          must(typeof t.type === "string" && TX_TYPES.has(t.type), "invalid transactions.type");
          const [inserted] = await tx.insert(transactions).values({
            ...(isStr(t.uuid) && t.uuid.length > 0 ? { uuid: t.uuid } : {}),
            account_id: accountId,
            category_id: categoryId,
            date: t.date,
            description: optStr(t.description) ?? "",
            amount_fx: t.amount_fx,
            exchange_rate: t.exchange_rate,
            amount_usd: t.amount_usd,
            type: t.type as TransactionType,
            transfer_group_id: optStr(t.transfer_group_id),
            transfer_direction: t.transfer_direction === "out" || t.transfer_direction === "in"
              ? t.transfer_direction
              : null,
            exclude_from_reports: t.exclude_from_reports === true,
            ...(isStr(t.created_at) ? { created_at: t.created_at } : {}),
            ...(isStr(t.updated_at) ? { updated_at: t.updated_at } : {}),
          }).returning({ id: transactions.id, uuid: transactions.uuid });
          txIds.set(t.id, inserted.id);
          transactionUuids.push(inserted.uuid);
        }

        const adjustmentUuids: string[] = [];
        for (const a of adjRows) {
          const accountId = isCents(a.account_id) ? accountIds.get(a.account_id) : undefined;
          must(accountId !== undefined, `account_adjustments.account_id ${a.account_id} does not resolve to an account`);
          must(isCents(a.old_balance) && isCents(a.new_balance), "adjustment balances must be integer cents");
          must(isStr(a.reason) && a.reason.length > 0, "account_adjustments.reason is required");
          const [inserted] = await tx.insert(accountAdjustments).values({
            ...(isStr(a.uuid) && a.uuid.length > 0 ? { uuid: a.uuid } : {}),
            account_id: accountId,
            old_balance: a.old_balance,
            new_balance: a.new_balance,
            reason: a.reason,
            ...(isStr(a.created_at) ? { created_at: a.created_at } : {}),
          }).returning({ uuid: accountAdjustments.uuid });
          adjustmentUuids.push(inserted.uuid);
        }

        for (const l of linkRows) {
          const txId = isCents(l.transaction_id) ? txIds.get(l.transaction_id) : undefined;
          const tagId = isCents(l.tag_id) ? tagIds.get(l.tag_id) : undefined;
          must(txId !== undefined && tagId !== undefined, "transaction_tags entry does not resolve");
          await tx.insert(transactionTags).values({ transaction_id: txId, tag_id: tagId });
        }

        // The ledger rows are authoritative. Recompute every imported account
        // before commit; for an early Archive v1 whose stored balance predates
        // the frozen-delta model, add one compatibility adjustment so that the
        // archived balance is preserved without leaving permanent drift.
        for (const a of accRows) {
          const accountId = accountIds.get(a.id as number)!;
          recomputeAccountBalance(tx, accountId);
          const [computed] = await tx.select({ balance: accounts.balance }).from(accounts).where(eq(accounts.id, accountId));
          const target = a.account_type === "RSU" ? 0 : (a.balance as number);
          if (computed.balance !== target) {
            const [adjustment] = await tx.insert(accountAdjustments).values({
              account_id: accountId,
              old_balance: computed.balance,
              new_balance: target,
              reason: "Opening balance (archive import)",
            }).returning({ uuid: accountAdjustments.uuid });
            adjustmentUuids.push(adjustment.uuid);
            recomputeAccountBalance(tx, accountId);
          }
        }

        // Build sync records only after every row and tag link exists, so
        // transaction payloads contain their complete tag UUID sets. These
        // outbox writes share this transaction with the archive restore.
        for (const uuid of accountUuids) recordChange({ entity: "account", entityUuid: uuid, op: "upsert" });
        for (const uuid of categoryUuids) recordChange({ entity: "category", entityUuid: uuid, op: "upsert" });
        for (const uuid of tagUuids) recordChange({ entity: "tag", entityUuid: uuid, op: "upsert" });
        for (const uuid of transactionUuids) recordChange({ entity: "transaction", entityUuid: uuid, op: "upsert" });
        for (const uuid of adjustmentUuids) recordChange({ entity: "account_adjustment", entityUuid: uuid, op: "upsert" });

        return {
          accounts: accRows.length,
          categories: catRows.length,
          tags: tagRows.length,
          transactions: txRows.length,
          account_adjustments: adjRows.length,
          transaction_tags: linkRows.length,
        };
      });

      const imported = Object.values(counts).reduce((s, n) => s + n, 0);
      res.status(201).json({ imported, counts });
    } catch (err) {
      if (err instanceof ArchiveError || err instanceof CoreArchiveError) {
        return res.status(400).json({ error: err.message, imported: 0 });
      }
      if (err instanceof ArchiveConflictError) {
        return res.status(409).json({ error: err.message, imported: 0 });
      }
      if (errorStatus(err) === 400 && err instanceof Error) {
        return res.status(400).json({ error: err.message, imported: 0 });
      }
      console.error("[data/import]", err);
      res.status(500).json({ error: "Failed to import data" });
    }
  });

  // GET /api/data/export/transactions.csv -- the ledger as a downloadable CSV
  // (money in dollars, account/category names resolved).
  router.get("/export/transactions.csv", async (req, res) => {
    try {
      const rows = await db
        .select({
          id: transactions.id,
          date: transactions.date,
          account: accounts.name,
          category: categories.name,
          description: transactions.description,
          amount_fx: transactions.amount_fx,
          exchange_rate: transactions.exchange_rate,
          amount_usd: transactions.amount_usd,
          type: transactions.type,
          exclude_from_reports: transactions.exclude_from_reports,
        })
        .from(transactions)
        .leftJoin(accounts, eq(transactions.account_id, accounts.id))
        .leftJoin(categories, eq(transactions.category_id, categories.id))
        .orderBy(desc(transactions.date), desc(transactions.id));

      const header = ["id", "date", "account", "category", "description", "amount_fx", "exchange_rate", "amount_usd", "type", "exclude_from_reports"];
      const lines = [csvRow(header)];
      for (const r of rows) {
        lines.push(csvRow([
          r.id, r.date, r.account ?? "", r.category ?? "", r.description,
          fromCents(r.amount_fx), r.exchange_rate, fromCents(r.amount_usd), r.type, r.exclude_from_reports,
        ]));
      }
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="balance-transactions-${new Date().toISOString().slice(0, 10)}.csv"`);
      res.send(lines.join("\n"));
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to export transactions CSV" });
    }
  });

  // POST /api/data/reset -- DESTRUCTIVE. Deletes ALL financial data (accounts,
  // transactions, categories, tags, adjustments, amazon cache). The body must
  // echo the fixed local household name ("Balance", also served by /api/me)
  // to confirm, preventing accidental deletion.
  router.post("/reset", async (req, res) => {
    try {
      const { confirm } = req.body as { confirm?: string };
      if (typeof confirm !== "string" || confirm.trim() !== LOCAL_HOUSEHOLD_NAME) {
        return res.status(400).json({
          error: `To confirm, send { "confirm": "${LOCAL_HOUSEHOLD_NAME}" }. This permanently deletes all accounts, transactions, categories, tags, and adjustments.`,
        });
      }

      await runTransaction(db, async (tx) => {
        const [accountRows, categoryRows, tagRows] = await Promise.all([
          tx.select({ uuid: accounts.uuid }).from(accounts),
          tx.select({ uuid: categories.uuid }).from(categories),
          tx.select({ uuid: tags.uuid }).from(tags),
        ]);
        // transaction_tags cascade from transactions/tags. Delete children first.
        await tx.delete(transactions);
        await tx.delete(accountAdjustments);
        await tx.delete(accounts);
        await tx.delete(categories);
        await tx.delete(tags);
        await tx.delete(amazonOrders);
        // Account deletion cascades its transactions and adjustments on every
        // replica; category and tag tombstones reproduce their own cascades.
        for (const row of accountRows) recordChange({ entity: "account", entityUuid: row.uuid, op: "delete" });
        for (const row of categoryRows) recordChange({ entity: "category", entityUuid: row.uuid, op: "delete" });
        for (const row of tagRows) recordChange({ entity: "tag", entityUuid: row.uuid, op: "delete" });
      });

      res.json({ ok: true, message: "Financial data deleted." });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to reset household data" });
    }
  });

  // POST /api/data/sample -- seed a synthetic demo dataset so a brand-new
  // household sees populated accounts and reports before entering any real
  // data. Admin only, and refused once the household has any account, so demo
  // rows can never mix into real books (reset first to re-seed).
  router.post("/sample", async (req, res) => {
    try {
      const counts = await seedSampleData(db);
      res.status(201).json({ ok: true, ...counts });
    } catch (err) {
      sendError(res, err, "Failed to load sample data");
    }
  });

  return router;
}

export default createDataRouter;
