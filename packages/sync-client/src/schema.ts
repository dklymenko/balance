import { sql } from "drizzle-orm";
import {
  sqliteTable,
  text,
  integer,
  real,
  primaryKey,
  unique,
  index,
  type AnySQLiteColumn,
} from "drizzle-orm/sqlite-core";

// Canonical device-local schema for synchronized Balance ledgers: application
// rows carry stable UUIDs, and the sync_state / sync_outbox / sync_conflicts
// tables track replication. Keeping these definitions in one package gives
// every local replica identical foreign-key cascade rules.

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

export type TransferDirection = "out" | "in";

// "income" categories (Salary, Dividends, ...) may only be used on credit
// (money-in) transactions; "expense" is the default and unrestricted.
export type CategoryKind = "income" | "expense" | "both";

// created_at/updated_at are ISO-8601 text (screens sort/filter on them
// lexically), matching JS `new Date().toISOString()`.
const isoNow = () => sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;

// Money is stored as integer cents (see core/finance.ts). exchange_rate and
// shares_quantity are genuine fractions, so they stay floating point.
// balance/balance_usd are DERIVED under the frozen-delta model: every write
// flows through recomputeAccountBalance() in the repo layer -- never assign
// them directly.
export const accounts = sqliteTable("accounts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  uuid: text("uuid").notNull(),
  name: text("name").notNull(),
  account_type: text("account_type").$type<AccountType>().notNull(),
  base_currency: text("base_currency").notNull().default("USD"),
  liquidity_type: text("liquidity_type").$type<LiquidityType>().notNull(),

  // Native balance in base_currency, in cents (e.g. EUR cents for a Euro account)
  balance: integer("balance").notNull().default(0),
  // Rate to convert balance -> USD. Always 1.0 for USD accounts.
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
  // Inactive accounts are hidden from the Accounts tab (behind a show/hide
  // toggle) and the new-transaction picker, but still count toward net worth
  // and reports. Used for legacy/closed accounts holding historical rows.
  is_active: integer("is_active", { mode: "boolean" }).notNull().default(true),
  // When true, this account's transactions are omitted from all report totals.
  // The account still appears in the ledger and counts toward net worth.
  exclude_from_reports: integer("exclude_from_reports", { mode: "boolean" }).notNull().default(false),
  created_at: text("created_at").notNull().default(isoNow()),
  updated_at: text("updated_at").notNull().default(isoNow()),
}, (table) => [unique("accounts_uuid_unique").on(table.uuid)]);

export const categories = sqliteTable("categories", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  uuid: text("uuid").notNull(),
  name: text("name").notNull(),
  // null = top-level; non-null = sub-category (max 1 level deep)
  // Explicit column type breaks the self-reference inference cycle (TS7022).
  parent_id: integer("parent_id").references((): AnySQLiteColumn => categories.id, {
    onDelete: "set null",
  }),
  kind: text("kind").$type<CategoryKind>().notNull().default("expense"),
  created_at: text("created_at").notNull().default(isoNow()),
}, (table) => [unique("categories_uuid_unique").on(table.uuid)]);

export const tags = sqliteTable("tags", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  uuid: text("uuid").notNull(),
  name: text("name").notNull(),
  created_at: text("created_at").notNull().default(isoNow()),
}, (table) => [
  unique("tags_name_unique").on(table.name),
  unique("tags_uuid_unique").on(table.uuid),
]);

export const transactions = sqliteTable("transactions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  uuid: text("uuid").notNull(),
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

  // Links the two legs of a transfer (same uuid on both rows).
  transfer_group_id: text("transfer_group_id"),
  // Explicit leg direction: row order cannot survive uuid-based replication.
  // Null on legacy lone legs; such rows contribute 0 to the balance.
  transfer_direction: text("transfer_direction").$type<TransferDirection>(),

  // When true, omitted from all reports but still in the ledger and balances.
  exclude_from_reports: integer("exclude_from_reports", { mode: "boolean" }).notNull().default(false),

  created_at: text("created_at").notNull().default(isoNow()),
  updated_at: text("updated_at").notNull().default(isoNow()),
}, (table) => [
  unique("transactions_uuid_unique").on(table.uuid),
  // The canonical balance recompute is a per-account SUM on every mutation --
  // keep it indexed.
  index("transactions_account_idx").on(table.account_id),
  index("transactions_date_idx").on(table.date),
]);

export const accountAdjustments = sqliteTable("account_adjustments", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  uuid: text("uuid").notNull(),
  account_id: integer("account_id")
    .notNull()
    .references(() => accounts.id, { onDelete: "cascade" }),
  old_balance: integer("old_balance").notNull(), // cents
  new_balance: integer("new_balance").notNull(), // cents
  reason: text("reason").notNull(),
  created_at: text("created_at").notNull().default(isoNow()),
}, (table) => [
  unique("account_adjustments_uuid_unique").on(table.uuid),
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

// Sync bookkeeping. sync_state is a kv store: mode ('local' |
// 'cloud'), cursor, client_id, household info. Kept separate from settings so
// "replace local data" flows can reason about sync state independently.
export const syncState = sqliteTable("sync_state", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

// Queue of local mutations awaiting push (cloud mode only). payload is the
// serialized PushOp; op_id doubles as the server-side idempotency key, so a
// replayed batch after a crash or 401 can never double-apply.
export const syncOutbox = sqliteTable("sync_outbox", {
  op_id: text("op_id").primaryKey(),
  entity: text("entity").notNull(),
  entity_uuid: text("entity_uuid").notNull(),
  type: text("type").notNull(),
  payload: text("payload").notNull(), // JSON PushOp
  created_at: text("created_at").notNull().default(isoNow()),
  attempts: integer("attempts").notNull().default(0),
  last_error: text("last_error"),
});

// Rejected/overwritten ops surfaced in the Activity screen -- LWW conflicts
// are made visible, not prevented.
export const syncConflicts = sqliteTable("sync_conflicts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  entity: text("entity").notNull(),
  entity_uuid: text("entity_uuid").notNull(),
  reason: text("reason").notNull(), // 'delete_wins' | 'stale_overwrite' | ...
  detail: text("detail").notNull().default("{}"), // JSON
  created_at: text("created_at").notNull().default(isoNow()),
});
