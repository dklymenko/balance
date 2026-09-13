import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  sqliteTable,
  text,
  integer,
  real,
  primaryKey,
  unique,
  uniqueIndex,
  index,
  type AnySQLiteColumn,
} from "drizzle-orm/sqlite-core";

// Single-user SQLite schema. Monetary values are stored as integer cents.

export type AccountType =
  | "Cash"
  | "Checking"
  | "Savings"
  | "CC"
  | "Investment"
  | "Roth401k"
  | "401k"
  | "HSA"
  | "Asset-NonLiquid"
  | "RSU";

export type LiquidityType = "Liquid" | "Invested" | "Locked";

export type TransactionType = "debit" | "credit" | "transfer";

// "income" categories (Salary, Dividends, …) may only be used on credit
// (money-in) transactions; "expense" is the default and unrestricted.
export type CategoryKind = "income" | "expense" | "both";

// created_at/updated_at are ISO-8601 text (the client expects ISO strings and
// sorts/filters on them lexically), matching JS `new Date().toISOString()`.
const isoNow = () => sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;

// Every replicated entity carries a UUID. Integer ids never cross the sync
// boundary; replicas map rows by UUID. The default is generated in JavaScript
// at insert time, and migrations backfill existing rows in SQL.
const uuidCol = () => text("uuid").notNull().$defaultFn(() => randomUUID());

export type TransferDirection = "out" | "in";

// Money is stored as integer cents (see lib/finance.ts). exchange_rate and
// shares_quantity are genuine fractions, so they stay floating point.
export const accounts = sqliteTable("accounts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  uuid: uuidCol(),
  name: text("name").notNull(),
  account_type: text("account_type").$type<AccountType>().notNull(),
  base_currency: text("base_currency").notNull().default("USD"),
  liquidity_type: text("liquidity_type").$type<LiquidityType>().notNull(),

  // Native balance in base_currency, in cents (e.g. EUR cents for a Euro account)
  balance: integer("balance").notNull().default(0),
  // Rate to convert balance → USD. Always 1.0 for USD accounts.
  exchange_rate: real("exchange_rate").notNull().default(1),
  // USD equivalent in cents = round(balance * exchange_rate)
  balance_usd: integer("balance_usd").notNull().default(0),

  // RSU-specific fields (null for all other account types)
  ticker: text("ticker"),
  shares_quantity: real("shares_quantity"),
  current_price_usd: integer("current_price_usd"), // cents

  sort_order: integer("sort_order"),
  notes: text("notes"),
  is_default: integer("is_default", { mode: "boolean" }).notNull().default(false),
  // Inactive accounts are hidden from the Accounts tab (behind a show/hide toggle)
  // and the new-transaction picker, but still count toward net worth and reports.
  // Used for legacy/closed accounts imported only to hold historical transactions.
  is_active: integer("is_active", { mode: "boolean" }).notNull().default(true),
  // When true, this account's transactions are omitted from all report totals
  // (spend-by-category, spend-over-time, income/spend/savings). The account still
  // appears in the ledger and counts toward net worth -- this only affects reports.
  exclude_from_reports: integer("exclude_from_reports", { mode: "boolean" }).notNull().default(false),
  created_at: text("created_at").notNull().default(isoNow()),
  updated_at: text("updated_at").notNull().default(isoNow()),
}, (table) => [uniqueIndex("accounts_uuid_unique").on(table.uuid)]);

export const categories = sqliteTable("categories", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  uuid: uuidCol(),
  name: text("name").notNull(),
  // null = top-level; non-null = sub-category (max 1 level deep)
  // Explicit column type breaks the self-reference inference cycle (TS7022).
  parent_id: integer("parent_id").references((): AnySQLiteColumn => categories.id, {
    onDelete: "set null",
  }),
  kind: text("kind").$type<CategoryKind>().notNull().default("expense"),
  created_at: text("created_at").notNull().default(isoNow()),
}, (table) => [uniqueIndex("categories_uuid_unique").on(table.uuid)]);

export const tags = sqliteTable("tags", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  uuid: uuidCol(),
  name: text("name").notNull(),
  created_at: text("created_at").notNull().default(isoNow()),
}, (table) => [
  unique("tags_name_unique").on(table.name),
  uniqueIndex("tags_uuid_unique").on(table.uuid),
]);

export const transactions = sqliteTable("transactions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  uuid: uuidCol(),
  account_id: integer("account_id")
    .notNull()
    .references(() => accounts.id, { onDelete: "cascade" }),
  category_id: integer("category_id").references(() => categories.id, {
    onDelete: "set null",
  }),

  date: text("date").notNull(), // ISO-8601: 'YYYY-MM-DD'
  description: text("description").notNull().default(""),

  // Original currency amount in cents (equals amount_usd when base_currency = USD)
  amount_fx: integer("amount_fx").notNull(),
  // Rate at time of transaction; 1.0 for USD accounts
  exchange_rate: real("exchange_rate").notNull().default(1),
  // Stored (not computed) to preserve the historical rate; cents
  amount_usd: integer("amount_usd").notNull(),

  type: text("type").$type<TransactionType>().notNull(),

  // Links the two legs of a transfer (same uuid on both rows). Read paths pair
  // legs by this id; the date+amount heuristic remains only as a fallback for
  // rows created before the column existed (null here).
  transfer_group_id: text("transfer_group_id"),
  // Explicit leg direction (frozen-delta model): historically direction lived
  // only in row-id order (lower id = out), which cannot survive uuid-based
  // replication. Backfilled by migration; unpairable legacy legs stay NULL
  // and contribute 0 to the canonical balance (lone-leg behavior).
  transfer_direction: text("transfer_direction").$type<TransferDirection>(),

  // When true, this transaction is omitted from all reports (spend-by-category,
  // spend-over-time, income/spend/savings) but still appears in the ledger and
  // counts toward account balances. For corrections, reimbursements, one-offs, etc.
  exclude_from_reports: integer("exclude_from_reports", { mode: "boolean" }).notNull().default(false),

  created_at: text("created_at").notNull().default(isoNow()),
  updated_at: text("updated_at").notNull().default(isoNow()),
}, (table) => [
  uniqueIndex("transactions_uuid_unique").on(table.uuid),
  // The canonical balance recompute is a per-account SUM on every mutation.
  index("transactions_account_idx").on(table.account_id),
]);

export const accountAdjustments = sqliteTable("account_adjustments", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  uuid: uuidCol(),
  account_id: integer("account_id")
    .notNull()
    .references(() => accounts.id, { onDelete: "cascade" }),
  old_balance: integer("old_balance").notNull(), // cents
  new_balance: integer("new_balance").notNull(), // cents
  reason: text("reason").notNull(),
  created_at: text("created_at").notNull().default(isoNow()),
}, (table) => [
  uniqueIndex("account_adjustments_uuid_unique").on(table.uuid),
  index("account_adjustments_account_idx").on(table.account_id),
]);

export const transactionTags = sqliteTable(
  "transaction_tags",
  {
    transaction_id: integer("transaction_id")
      .notNull()
      .references(() => transactions.id, { onDelete: "cascade" }),
    tag_id: integer("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
  },
  (table) => [primaryKey({ columns: [table.transaction_id, table.tag_id] })]
);

// Single-row-per-key app settings (base_currency, ...). Lives in the DB file
// so it participates in backups and the Balance archive migration path is
// unaffected (settings are cosmetic, not financial data).
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

// Legacy cache retained so existing databases keep a stable schema. Current
// matching clears this table at the start of every run and never persists the
// locally scraped order titles.
export const amazonOrders = sqliteTable("amazon_orders", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  amazon_order_id: text("amazon_order_id"),
  order_date: text("order_date").notNull(), // YYYY-MM-DD
  amount_usd: integer("amount_usd").notNull(), // cents
  items: text("items").notNull().default(""),
  scraped_at: text("scraped_at").notNull().default(isoNow()),
});

// ── Sync bookkeeping (desktop cloud mode) ────────────────────────────────────
// Used by the @balance/sync-client integration in Balance Desktop's cloud
// mode; empty and inert in local-only use. Kept in this schema so
// there is exactly one migration chain per database file.

// kv: mode ('local' | 'cloud'), cursor, client_id, household info.
export const syncState = sqliteTable("sync_state", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

// Queue of local mutations awaiting push. payload is the serialized wire op;
// op_id doubles as the server-side idempotency key.
export const syncOutbox = sqliteTable("sync_outbox", {
  op_id: text("op_id").primaryKey(),
  entity: text("entity").notNull(),
  entity_uuid: text("entity_uuid").notNull(),
  type: text("type").notNull(),
  payload: text("payload").notNull(), // JSON wire op
  created_at: text("created_at").notNull().default(isoNow()),
  attempts: integer("attempts").notNull().default(0),
  last_error: text("last_error"),
});

// Rejected/overwritten ops surfaced in the sync activity UI -- LWW conflicts
// are made visible, not prevented.
export const syncConflicts = sqliteTable("sync_conflicts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  entity: text("entity").notNull(),
  entity_uuid: text("entity_uuid").notNull(),
  reason: text("reason").notNull(), // 'delete_wins' | 'stale_overwrite' | ...
  detail: text("detail").notNull().default("{}"), // JSON
  created_at: text("created_at").notNull().default(isoNow()),
});
