// Applies pulled changes and snapshots to the local DB. Each page commits in
// ONE SQLite transaction together with the cursor write -- kill the app
// between apply and cursor persist and the page simply replays because upserts
// are idempotent by uuid.
//
// Apply order: accounts → categories (parents first) → tags → transactions
// (+tag links) → adjustments; deletes in reverse. Deleting an account fires
// the local ON DELETE CASCADE, mirroring the server cascade -- "cascades
// replicate as cascades".
import { eq, inArray, ne } from "drizzle-orm";
import {
  accounts, accountAdjustments, categories, syncConflicts, syncOutbox, tags, transactions, transactionTags,
  type AccountType, type CategoryKind, type LiquidityType, type TransactionType, type TransferDirection,
} from "./schema.js";
import type { DB, DbExecutor, Tx } from "./types.js";
import {
  isStorableCents, SyncWireError,
  type PullChange, type PullUpsertChange, type SnapshotResponse, type SyncEntity,
} from "@balance/core";
import { recomputeAccounts } from "./recompute.js";
import { setCursor, setSyncValue } from "./state.js";

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}
function num(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}
function bool(v: unknown): boolean {
  return v === true;
}
function strOrNull(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}
function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

const ACCOUNT_TYPES = new Set(["Cash", "Checking", "Savings", "CC", "Investment", "Roth401k", "401k", "HSA", "Asset-NonLiquid", "RSU"]);
const LIQUIDITY_TYPES = new Set(["Liquid", "Invested", "Locked"]);
const CATEGORY_KINDS = new Set(["income", "expense", "both"]);
const MAX_TEXT = 10_000;

function validText(value: unknown, max = MAX_TEXT): value is string {
  return typeof value === "string" && value.length <= max;
}

function validUuid(value: unknown, nullable = false): boolean {
  return (nullable && value === null) || (typeof value === "string" && value.length > 0 && value.length <= 64);
}

function validNumber(value: unknown, max = 1e9, min = 0): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

function validCents(value: unknown): value is number {
  return isStorableCents(value);
}

function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

function validNullableText(value: unknown, max = MAX_TEXT): boolean {
  return value === null || validText(value, max);
}

function validNullableNumber(value: unknown, max = 1e9): boolean {
  return value === null || validNumber(value, max);
}

function assertData(entity: SyncEntity, data: Record<string, unknown>): void {
  const fail = (message: string): never => { throw new SyncWireError(`${entity} payload ${message}`); };
  if (entity === "account") {
    if (!validText(data.name, 200) || data.name.trim().length === 0) fail("has an invalid name");
    if (typeof data.account_type !== "string" || !ACCOUNT_TYPES.has(data.account_type)) fail("has an invalid account_type");
    if (typeof data.base_currency !== "string" || !/^[A-Z]{3}$/.test(data.base_currency)) fail("has an invalid base_currency");
    if (typeof data.liquidity_type !== "string" || !LIQUIDITY_TYPES.has(data.liquidity_type)) fail("has an invalid liquidity_type");
    if (!validNumber(data.exchange_rate, 1e9, Number.MIN_VALUE)) fail("has an invalid exchange_rate");
    if (!validNullableText(data.ticker, 32) || !validNullableNumber(data.shares_quantity) ||
        !(data.current_price_usd === null || (validCents(data.current_price_usd) && data.current_price_usd >= 0)) ||
        !(data.sort_order === null || Number.isSafeInteger(data.sort_order)) || !validNullableText(data.notes)) fail("has invalid optional fields");
    if (data.account_type === "RSU" && typeof data.shares_quantity === "number" && typeof data.current_price_usd === "number" &&
        !validCents(Math.round(data.shares_quantity * data.current_price_usd))) fail("has an unrepresentable market value");
    if (typeof data.is_default !== "boolean" || typeof data.is_active !== "boolean" || typeof data.exclude_from_reports !== "boolean") fail("has invalid flags");
  } else if (entity === "category") {
    if (!validText(data.name, 200) || data.name.trim().length === 0 || !validUuid(data.parent_uuid, true) ||
        typeof data.kind !== "string" || !CATEGORY_KINDS.has(data.kind)) fail("is invalid");
  } else if (entity === "tag") {
    if (!validText(data.name, 200) || data.name.trim().length === 0) fail("has an invalid name");
  } else if (entity === "transaction") {
    if (!validUuid(data.account_uuid) || !validUuid(data.category_uuid, true) || !validDate(data.date) ||
        !validText(data.description) || !validCents(data.amount_fx) || (data.amount_fx as number) <= 0 ||
        !validNumber(data.exchange_rate, 1e9, Number.MIN_VALUE) ||
        (data.type !== "debit" && data.type !== "credit" && data.type !== "transfer") ||
        typeof data.exclude_from_reports !== "boolean") fail("is invalid");
    const isTransfer = data.type === "transfer";
    if (isTransfer !== (typeof data.transfer_group_id === "string" && data.transfer_group_id.length > 0 && data.transfer_group_id.length <= 64) ||
        isTransfer !== (data.transfer_direction === "out" || data.transfer_direction === "in")) fail("has inconsistent transfer metadata");
    if (!Array.isArray(data.tag_uuids) || data.tag_uuids.length > 1_000 || !data.tag_uuids.every((uuid) => validUuid(uuid)) ||
        new Set(data.tag_uuids).size !== data.tag_uuids.length) fail("has invalid tag references");
    if (!validCents(Math.round((data.amount_fx as number) * (data.exchange_rate as number)))) {
      fail("has an unrepresentable amount_fx x exchange_rate");
    }
  } else {
    if (!validUuid(data.account_uuid) || !validCents(data.old_balance) || !validCents(data.new_balance) ||
        !validText(data.reason) || data.reason.trim().length === 0) fail("is invalid");
  }
  if (!validText(data.created_at, 64)) fail("has an invalid created_at");
  if ((entity === "account" || entity === "transaction") && !validText(data.updated_at, 64)) fail("has an invalid updated_at");
}

function accountIdByUuid(exec: DbExecutor, uuid: string): number | null {
  return exec.select({ id: accounts.id }).from(accounts).where(eq(accounts.uuid, uuid)).get()?.id ?? null;
}
function categoryIdByUuid(exec: DbExecutor, uuid: string | null): number | null {
  if (!uuid) return null;
  return exec.select({ id: categories.id }).from(categories).where(eq(categories.uuid, uuid)).get()?.id ?? null;
}

// An applied upsert fully overwrites the row's syncable fields (LWW) --
// balances stay local-computed.
function applyAccountUpsert(exec: DbExecutor, uuid: string, d: Record<string, unknown>): number {
  const values = {
    name: str(d.name),
    account_type: str(d.account_type, "Checking") as AccountType,
    base_currency: str(d.base_currency, "USD"),
    liquidity_type: str(d.liquidity_type, "Liquid") as LiquidityType,
    exchange_rate: num(d.exchange_rate, 1),
    ticker: strOrNull(d.ticker),
    shares_quantity: numOrNull(d.shares_quantity),
    current_price_usd: numOrNull(d.current_price_usd),
    sort_order: numOrNull(d.sort_order),
    notes: strOrNull(d.notes),
    is_default: bool(d.is_default),
    is_active: d.is_active !== false,
    exclude_from_reports: bool(d.exclude_from_reports),
    updated_at: str(d.updated_at, new Date().toISOString()),
  };
  const existing = accountIdByUuid(exec, uuid);
  let accountId: number;
  if (existing != null) {
    exec.update(accounts).set(values).where(eq(accounts.id, existing)).run();
    accountId = existing;
  } else {
    const [row] = exec
      .insert(accounts)
      .values({ ...values, uuid, created_at: str(d.created_at, new Date().toISOString()) })
      .returning({ id: accounts.id })
      .all();
    accountId = row.id;
  }
  // The local API guarantees at most one default. Cloud account changes are
  // independent LWW records, so two devices can briefly nominate different
  // defaults. Resolve that conflict in sequence order while applying a page;
  // every replica then makes the same last-change-wins choice.
  if (values.is_default) {
    exec.update(accounts).set({ is_default: false })
      .where(ne(accounts.id, accountId)).run();
  }
  return accountId;
}

function applyCategoryUpsert(exec: DbExecutor, uuid: string, d: Record<string, unknown>): void {
  const values = {
    name: str(d.name),
    kind: (str(d.kind, "expense") || "expense") as CategoryKind,
    parent_id: categoryIdByUuid(exec, strOrNull(d.parent_uuid)),
  };
  const existing = exec.select({ id: categories.id }).from(categories).where(eq(categories.uuid, uuid)).get();
  if (existing) {
    exec.update(categories).set(values).where(eq(categories.id, existing.id)).run();
  } else {
    exec.insert(categories).values({ ...values, uuid, created_at: str(d.created_at, new Date().toISOString()) }).run();
  }
}

function applyTagUpsert(exec: DbExecutor, uuid: string, d: Record<string, unknown>): void {
  const existing = exec.select({ id: tags.id }).from(tags).where(eq(tags.uuid, uuid)).get();
  if (existing) {
    exec.update(tags).set({ name: str(d.name) }).where(eq(tags.id, existing.id)).run();
  } else {
    exec.insert(tags).values({ uuid, name: str(d.name), created_at: str(d.created_at, new Date().toISOString()) }).run();
  }
}

// Returns the touched local account ids (old account too, when a pulled edit
// moved the row between accounts).
function applyTransactionUpsert(exec: DbExecutor, uuid: string, d: Record<string, unknown>): number[] {
  const accountId = accountIdByUuid(exec, str(d.account_uuid));
  // Parent missing locally: the account's delete wins server-side and its
  // tombstone reaches us in this or a later page -- dropping the upsert is the
  // converged outcome.
  if (accountId == null) return [];
  const values = {
    account_id: accountId,
    category_id: categoryIdByUuid(exec, strOrNull(d.category_uuid)),
    date: str(d.date),
    description: str(d.description),
    amount_fx: num(d.amount_fx),
    exchange_rate: num(d.exchange_rate, 1),
    amount_usd: Math.round(num(d.amount_fx) * num(d.exchange_rate, 1)),
    type: str(d.type, "debit") as TransactionType,
    transfer_group_id: strOrNull(d.transfer_group_id),
    transfer_direction: (d.transfer_direction === "out" || d.transfer_direction === "in"
      ? d.transfer_direction
      : null) as TransferDirection | null,
    exclude_from_reports: bool(d.exclude_from_reports),
    updated_at: str(d.updated_at, new Date().toISOString()),
  };
  const existing = exec
    .select({ id: transactions.id, account_id: transactions.account_id })
    .from(transactions)
    .where(eq(transactions.uuid, uuid))
    .get();
  let txId: number;
  const touched = [accountId];
  if (existing) {
    exec.update(transactions).set(values).where(eq(transactions.id, existing.id)).run();
    txId = existing.id;
    if (existing.account_id !== accountId) touched.push(existing.account_id);
  } else {
    const [row] = exec
      .insert(transactions)
      .values({ ...values, uuid, created_at: str(d.created_at, new Date().toISOString()) })
      .returning({ id: transactions.id })
      .all();
    txId = row.id;
  }

  // tag_uuids replicate replace-the-set on the transaction.
  const tagUuids = Array.isArray(d.tag_uuids) ? d.tag_uuids.filter((t): t is string => typeof t === "string") : [];
  exec.delete(transactionTags).where(eq(transactionTags.transaction_id, txId)).run();
  if (tagUuids.length > 0) {
    const tagRows = exec.select({ id: tags.id }).from(tags).where(inArray(tags.uuid, tagUuids)).all();
    if (tagRows.length > 0) {
      exec.insert(transactionTags).values(tagRows.map((t) => ({ transaction_id: txId, tag_id: t.id }))).run();
    }
  }
  return touched;
}

function applyAdjustmentUpsert(exec: DbExecutor, uuid: string, d: Record<string, unknown>): number[] {
  const accountId = accountIdByUuid(exec, str(d.account_uuid));
  if (accountId == null) return [];
  const values = {
    account_id: accountId,
    old_balance: num(d.old_balance),
    new_balance: num(d.new_balance),
    reason: str(d.reason),
  };
  const existing = exec
    .select({ id: accountAdjustments.id })
    .from(accountAdjustments)
    .where(eq(accountAdjustments.uuid, uuid))
    .get();
  if (existing) {
    exec.update(accountAdjustments).set(values).where(eq(accountAdjustments.id, existing.id)).run();
  } else {
    exec.insert(accountAdjustments).values({ ...values, uuid, created_at: str(d.created_at, new Date().toISOString()) }).run();
  }
  return [accountId];
}

// Delete by uuid; local FK cascades reproduce the server-side cascade.
// Returns touched account ids (for recompute) discovered before the delete.
function applyDelete(exec: DbExecutor, entity: SyncEntity, uuid: string): number[] {
  switch (entity) {
    case "account": {
      const row = exec.select({ id: accounts.id }).from(accounts).where(eq(accounts.uuid, uuid)).get();
      if (row) exec.delete(accounts).where(eq(accounts.id, row.id)).run();
      return [];
    }
    case "category": {
      const row = exec.select({ id: categories.id }).from(categories).where(eq(categories.uuid, uuid)).get();
      if (row) exec.delete(categories).where(eq(categories.id, row.id)).run();
      return [];
    }
    case "tag": {
      const row = exec.select({ id: tags.id }).from(tags).where(eq(tags.uuid, uuid)).get();
      if (row) exec.delete(tags).where(eq(tags.id, row.id)).run();
      return [];
    }
    case "transaction": {
      const row = exec
        .select({ id: transactions.id, account_id: transactions.account_id })
        .from(transactions)
        .where(eq(transactions.uuid, uuid))
        .get();
      if (!row) return [];
      exec.delete(transactions).where(eq(transactions.id, row.id)).run();
      return [row.account_id];
    }
    case "account_adjustment": {
      const row = exec
        .select({ id: accountAdjustments.id, account_id: accountAdjustments.account_id })
        .from(accountAdjustments)
        .where(eq(accountAdjustments.uuid, uuid))
        .get();
      if (!row) return [];
      exec.delete(accountAdjustments).where(eq(accountAdjustments.id, row.id)).run();
      return [row.account_id];
    }
  }
}

const UPSERT_ORDER: SyncEntity[] = ["account", "category", "tag", "transaction", "account_adjustment"];

function applyUpsert(exec: DbExecutor, change: PullUpsertChange): number[] {
  assertData(change.entity, change.data);
  switch (change.entity) {
    case "account":
      return [applyAccountUpsert(exec, change.uuid, change.data)];
    case "category":
      applyCategoryUpsert(exec, change.uuid, change.data);
      return [];
    case "tag":
      applyTagUpsert(exec, change.uuid, change.data);
      return [];
    case "transaction":
      return applyTransactionUpsert(exec, change.uuid, change.data);
    case "account_adjustment":
      return applyAdjustmentUpsert(exec, change.uuid, change.data);
  }
}

// One pulled page: apply + persist cursor atomically; recompute every touched
// account before commit so the UI never observes a stale balance.
export function applyPullPage(db: DB, changes: PullChange[], newCursor: number): void {
  db.transaction((tx: Tx) => {
    const touched = new Set<number>();

    for (const entity of UPSERT_ORDER) {
      const upserts = changes.filter((c): c is PullUpsertChange => c.op === "upsert" && c.entity === entity);
      // Parent categories before children so parent_uuid resolves in-page.
      const ordered = entity === "category"
        ? [...upserts.filter((c) => !c.data.parent_uuid), ...upserts.filter((c) => c.data.parent_uuid)]
        : upserts;
      for (const change of ordered) {
        for (const id of applyUpsert(tx, change)) touched.add(id);
      }
    }

    for (const entity of [...UPSERT_ORDER].reverse()) {
      for (const change of changes.filter((c) => c.op === "delete" && c.entity === entity)) {
        for (const id of applyDelete(tx, change.entity, change.uuid)) touched.add(id);
      }
    }

    // Deleted accounts fall out of the recompute set naturally (their rows
    // are gone; recompute of a missing id is a no-op).
    recomputeAccounts(tx, touched);
    setCursor(tx, newCursor);
  });
}

// New-device hydration (wizard branch b/c): snapshot into an empty ledger.
export function hydrateFromSnapshot(
  db: DB,
  snapshot: SnapshotResponse,
  options: { replace?: boolean; activateClientId?: string } = {},
): void {
  db.transaction((tx: Tx) => {
    if (options.replace) {
      tx.delete(transactionTags).run();
      tx.delete(transactions).run();
      tx.delete(accountAdjustments).run();
      tx.delete(tags).run();
      tx.delete(categories).run();
      tx.delete(accounts).run();
      tx.delete(syncOutbox).run();
      tx.delete(syncConflicts).run();
    }
    for (const row of snapshot.accounts) { assertData("account", row); applyAccountUpsert(tx, row.uuid, row); }
    const cats = [...snapshot.categories.filter((c) => !c.parent_uuid), ...snapshot.categories.filter((c) => c.parent_uuid)];
    for (const row of cats) { assertData("category", row); applyCategoryUpsert(tx, row.uuid, row); }
    for (const row of snapshot.tags) { assertData("tag", row); applyTagUpsert(tx, row.uuid, row); }
    for (const row of snapshot.transactions) { assertData("transaction", row); applyTransactionUpsert(tx, row.uuid, row); }
    for (const row of snapshot.account_adjustments) { assertData("account_adjustment", row); applyAdjustmentUpsert(tx, row.uuid, row); }
    const ids = tx.select({ id: accounts.id }).from(accounts).all().map((r) => r.id);
    recomputeAccounts(tx, ids);
    setCursor(tx, snapshot.cursor);
    if (options.activateClientId) {
      setSyncValue(tx, "client_id", options.activateClientId);
      setSyncValue(tx, "mode", "cloud");
    }
  });
}
