// The "Balance archive" (Archive v1) is a portable, versioned JSON contract.
// Money is integer cents. Row ids exist only so importers can remap
// cross-references; they are never reused.
//
// Each row may carry a `uuid`, which the sync
// import preserves so every local row acquires server identity with nothing
// re-downloaded. Plain Archive v1 files without uuids stay valid.

import { isStorableCents } from "./finance.js";

export const ARCHIVE_FORMAT = "balance-archive";
export const ARCHIVE_VERSION = 1;

const ACCOUNT_TYPES = new Set<string>([
  "Cash", "Checking", "Savings", "CC", "Investment", "Roth401k", "401k", "HSA",
  "Asset-NonLiquid", "RSU",
]);
const LIQUIDITY_TYPES = new Set<string>(["Liquid", "Invested", "Locked"]);
const TX_TYPES = new Set<string>(["debit", "credit", "transfer"]);
const CATEGORY_KINDS = new Set<string>(["income", "expense", "both"]);

// Generous per-table row caps so a malformed or hostile archive cannot make
// the importer chew through unbounded work.
const MAX_ROWS: Record<string, number> = {
  accounts: 2_000,
  categories: 2_000,
  tags: 5_000,
  transactions: 200_000,
  account_adjustments: 20_000,
  transaction_tags: 400_000,
};
const MAX_STR = 10_000;

export class ArchiveError extends Error {}

function must(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new ArchiveError(msg);
}

// Shared with every server write path, so anything the API stores validates
// here too (see isStorableCents in ./finance).
const isCents = isStorableCents;

function isPositiveId(v: unknown): v is number {
  return isCents(v) && v > 0;
}

function isDate(v: unknown): v is string {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const [year, month, day] = v.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day;
}

function hasUniqueIds(rows: Array<{ id: number }>): boolean {
  return new Set(rows.map((row) => row.id)).size === rows.length;
}

function isStr(v: unknown): v is string {
  return typeof v === "string" && v.length <= MAX_STR;
}

function optStr(v: unknown): string | null {
  return isStr(v) ? v : null;
}

function optUuid(v: unknown, field: string): string | undefined {
  if (v === undefined) return undefined;
  must(typeof v === "string" && v.length > 0 && v.length <= 64, `${field} must be a non-empty string of at most 64 characters`);
  return v;
}

function hasUniqueUuids(rows: Array<{ uuid?: string }>): boolean {
  const values = rows.flatMap((row) => row.uuid === undefined ? [] : [row.uuid]);
  return new Set(values).size === values.length;
}

function isRow(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function tableOf(archive: Record<string, unknown>, name: string): Record<string, unknown>[] {
  const raw = archive[name] ?? [];
  must(Array.isArray(raw), `${name} must be an array`);
  must(raw.length <= MAX_ROWS[name], `${name} exceeds the ${MAX_ROWS[name]} row limit`);
  raw.forEach((r) => must(isRow(r), `${name} contains a non-object entry`));
  return raw as Record<string, unknown>[];
}

export interface ArchiveAccount {
  id: number;
  uuid?: string;
  name: string;
  account_type: string;
  base_currency: string;
  liquidity_type: string;
  balance: number;
  exchange_rate: number;
  balance_usd: number;
  ticker: string | null;
  shares_quantity: number | null;
  current_price_usd: number | null;
  sort_order: number | null;
  notes: string | null;
  is_default: boolean;
  is_active: boolean;
  exclude_from_reports: boolean;
  created_at?: string;
  updated_at?: string;
}

export interface ArchiveCategory {
  id: number;
  uuid?: string;
  name: string;
  parent_id: number | null;
  kind: string;
  created_at?: string;
}

export interface ArchiveTag {
  id: number;
  uuid?: string;
  name: string;
  created_at?: string;
}

export interface ArchiveTransaction {
  id: number;
  uuid?: string;
  account_id: number;
  category_id: number | null;
  date: string;
  description: string;
  amount_fx: number;
  exchange_rate: number;
  amount_usd: number;
  type: string;
  transfer_group_id: string | null;
  transfer_direction?: string | null;
  exclude_from_reports: boolean;
  created_at?: string;
  updated_at?: string;
}

export interface ArchiveAdjustment {
  id: number;
  uuid?: string;
  account_id: number;
  old_balance: number;
  new_balance: number;
  reason: string;
  created_at?: string;
}

export interface ArchiveTagLink {
  transaction_id: number;
  tag_id: number;
}

export interface BalanceArchive {
  format: typeof ARCHIVE_FORMAT;
  version: typeof ARCHIVE_VERSION;
  exported_at: string;
  accounts: ArchiveAccount[];
  categories: ArchiveCategory[];
  tags: ArchiveTag[];
  transactions: ArchiveTransaction[];
  account_adjustments: ArchiveAdjustment[];
  transaction_tags: ArchiveTagLink[];
}

// Validate an untrusted parsed-JSON value into a typed archive. Throws
// ArchiveError with a row-level message on the first violation -- the caller
// treats any throw as "not a valid Balance archive" (all-or-nothing).
export function validateArchive(raw: unknown): BalanceArchive {
  must(isRow(raw), "archive must be an object");
  must(
    raw.format === ARCHIVE_FORMAT && raw.version === ARCHIVE_VERSION,
    `Expected a Balance archive ({ format: "${ARCHIVE_FORMAT}", version: ${ARCHIVE_VERSION} })`,
  );

  const accounts = tableOf(raw, "accounts").map((a): ArchiveAccount => {
    must(isPositiveId(a.id), "accounts.id must be a positive integer");
    must(isStr(a.name) && a.name.trim().length > 0 && a.name.length <= 200, "accounts.name is required");
    must(typeof a.account_type === "string" && ACCOUNT_TYPES.has(a.account_type), "invalid accounts.account_type");
    must(typeof a.liquidity_type === "string" && LIQUIDITY_TYPES.has(a.liquidity_type), "invalid accounts.liquidity_type");
    must(isCents(a.balance) && isCents(a.balance_usd), "account balances must be integer cents");
    must(a.current_price_usd == null || (isCents(a.current_price_usd) && a.current_price_usd >= 0), "accounts.current_price_usd must be non-negative integer cents or null");
    must(typeof a.exchange_rate === "number" && Number.isFinite(a.exchange_rate) && a.exchange_rate > 0 && a.exchange_rate <= 1e9, "accounts.exchange_rate must be positive");
    must(a.shares_quantity == null || (typeof a.shares_quantity === "number" && Number.isFinite(a.shares_quantity) && a.shares_quantity >= 0 && a.shares_quantity <= 1e9), "invalid accounts.shares_quantity");
    if (a.account_type === "RSU" && typeof a.shares_quantity === "number" && typeof a.current_price_usd === "number") {
      must(isCents(Math.round(a.shares_quantity * a.current_price_usd)), "accounts RSU market value is outside the supported money range");
    }
    must(a.base_currency == null || (typeof a.base_currency === "string" && /^[A-Z]{3}$/.test(a.base_currency)), "invalid accounts.base_currency");
    must(a.ticker == null || (typeof a.ticker === "string" && a.ticker.length <= 32), "invalid accounts.ticker");
    return {
      id: a.id,
      uuid: optUuid(a.uuid, "accounts.uuid"),
      name: a.name,
      account_type: a.account_type,
      base_currency: optStr(a.base_currency) ?? "USD",
      liquidity_type: a.liquidity_type,
      balance: a.balance,
      exchange_rate: a.exchange_rate,
      balance_usd: a.balance_usd,
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
    };
  });
  must(hasUniqueIds(accounts), "accounts.id values must be unique");
  must(hasUniqueUuids(accounts), "accounts.uuid values must be unique");
  const accountIds = new Set(accounts.map((a) => a.id));

  const categories = tableOf(raw, "categories").map((c): ArchiveCategory => {
    must(isPositiveId(c.id), "categories.id must be a positive integer");
    must(isStr(c.name) && c.name.trim().length > 0 && c.name.length <= 200, "categories.name is required");
    must(c.parent_id == null || isPositiveId(c.parent_id), "categories.parent_id must be a positive integer or null");
    const kind = typeof c.kind === "string" && CATEGORY_KINDS.has(c.kind) ? c.kind : "expense";
    return {
      id: c.id,
      uuid: optUuid(c.uuid, "categories.uuid"),
      name: c.name,
      parent_id: c.parent_id == null ? null : (c.parent_id as number),
      kind,
      ...(isStr(c.created_at) ? { created_at: c.created_at } : {}),
    };
  });
  must(hasUniqueIds(categories), "categories.id values must be unique");
  must(hasUniqueUuids(categories), "categories.uuid values must be unique");
  const categoryIds = new Set(categories.map((c) => c.id));
  const categoryById = new Map(categories.map((c) => [c.id, c]));
  for (const c of categories) {
    must(c.parent_id == null || categoryIds.has(c.parent_id), "categories.parent_id references a missing category");
    must(c.parent_id !== c.id, "category cannot be its own parent");
    must(c.parent_id == null || categoryById.get(c.parent_id)?.parent_id == null, "categories may be at most one level deep");
  }

  const tags = tableOf(raw, "tags").map((t): ArchiveTag => {
    must(isPositiveId(t.id), "tags.id must be a positive integer");
    must(isStr(t.name) && t.name.trim().length > 0 && t.name.length <= 200, "tags.name is required");
    return {
      id: t.id,
      uuid: optUuid(t.uuid, "tags.uuid"),
      name: t.name,
      ...(isStr(t.created_at) ? { created_at: t.created_at } : {}),
    };
  });
  must(hasUniqueIds(tags), "tags.id values must be unique");
  must(hasUniqueUuids(tags), "tags.uuid values must be unique");
  const tagIds = new Set(tags.map((t) => t.id));

  const transactions = tableOf(raw, "transactions").map((t): ArchiveTransaction => {
    must(isPositiveId(t.id), "transactions.id must be a positive integer");
    must(isPositiveId(t.account_id) && accountIds.has(t.account_id), "transactions.account_id references a missing account");
    must(t.category_id == null || (isPositiveId(t.category_id) && categoryIds.has(t.category_id)), "transactions.category_id references a missing category");
    must(isDate(t.date), "transactions.date must be a real calendar date in YYYY-MM-DD format");
    must(isCents(t.amount_fx) && t.amount_fx > 0 && isCents(t.amount_usd), "transaction amounts must be positive integer cents");
    must(typeof t.exchange_rate === "number" && Number.isFinite(t.exchange_rate) && t.exchange_rate > 0 && t.exchange_rate <= 1e9, "transactions.exchange_rate must be positive");
    must(typeof t.type === "string" && TX_TYPES.has(t.type), "invalid transactions.type");
    const direction = t.transfer_direction === "out" || t.transfer_direction === "in" ? t.transfer_direction : null;
    return {
      id: t.id,
      uuid: optUuid(t.uuid, "transactions.uuid"),
      account_id: t.account_id,
      category_id: t.category_id == null ? null : (t.category_id as number),
      date: t.date,
      description: optStr(t.description) ?? "",
      amount_fx: t.amount_fx,
      exchange_rate: t.exchange_rate,
      amount_usd: t.amount_usd,
      type: t.type,
      transfer_group_id: optStr(t.transfer_group_id),
      transfer_direction: direction,
      exclude_from_reports: t.exclude_from_reports === true,
      ...(isStr(t.created_at) ? { created_at: t.created_at } : {}),
      ...(isStr(t.updated_at) ? { updated_at: t.updated_at } : {}),
    };
  });
  must(hasUniqueIds(transactions), "transactions.id values must be unique");
  must(hasUniqueUuids(transactions), "transactions.uuid values must be unique");

  const transferGroups = new Map<string, ArchiveTransaction[]>();
  for (const transaction of transactions) {
    if (transaction.type !== "transfer") {
      must(
        transaction.transfer_group_id == null && transaction.transfer_direction == null,
        "non-transfer transactions cannot carry transfer metadata",
      );
      const derived = Math.round(transaction.amount_fx * transaction.exchange_rate);
      must(isCents(derived), "transactions.amount_usd is outside the supported money range");
      must(transaction.amount_usd === derived, "transactions.amount_usd must equal amount_fx x exchange_rate");
      continue;
    }
    must(transaction.category_id == null, "transfer transactions cannot have a category");
    must(
      typeof transaction.transfer_group_id === "string" && transaction.transfer_group_id.length > 0 && transaction.transfer_group_id.length <= 64,
      "transfer transactions require a transfer_group_id",
    );
    const group = transferGroups.get(transaction.transfer_group_id);
    if (group) group.push(transaction); else transferGroups.set(transaction.transfer_group_id, [transaction]);
  }
  for (const group of transferGroups.values()) {
    must(group.length === 2, "each transfer group must contain exactly two legs");
    must(group[0].account_id !== group[1].account_id, "transfer legs must use different accounts");
    const out = group.filter((row) => row.transfer_direction === "out");
    const incoming = group.filter((row) => row.transfer_direction === "in");
    if (out.length === 0 && incoming.length === 0) {
      // Early Archive v1 exports did not carry direction. Creation order was
      // deterministic (outbound first), so preserve compatibility safely.
      group.sort((a, b) => a.id - b.id);
      group[0].transfer_direction = "out";
      group[1].transfer_direction = "in";
    } else if (out.length === 1 && incoming.length === 0) {
      group.find((row) => row.transfer_direction == null)!.transfer_direction = "in";
    } else if (incoming.length === 1 && out.length === 0) {
      group.find((row) => row.transfer_direction == null)!.transfer_direction = "out";
    }
    must(
      group.filter((row) => row.transfer_direction === "out").length === 1 &&
        group.filter((row) => row.transfer_direction === "in").length === 1,
      "each transfer group must contain one inbound and one outbound leg",
    );
    const outbound = group.find((row) => row.transfer_direction === "out")!;
    const inbound = group.find((row) => row.transfer_direction === "in")!;
    must(outbound.amount_usd === inbound.amount_usd, "transfer legs must carry the same amount_usd");
    const derived = Math.round(outbound.amount_fx * outbound.exchange_rate);
    must(isCents(derived), "transfer amount_usd is outside the supported money range");
    must(outbound.amount_usd === derived, "outbound transfer amount_usd must equal amount_fx x exchange_rate");
  }
  const txIds = new Set(transactions.map((t) => t.id));

  const account_adjustments = tableOf(raw, "account_adjustments").map((a): ArchiveAdjustment => {
    must(isPositiveId(a.id), "account_adjustments.id must be a positive integer");
    must(isPositiveId(a.account_id) && accountIds.has(a.account_id), "account_adjustments.account_id references a missing account");
    must(isCents(a.old_balance) && isCents(a.new_balance), "adjustment balances must be integer cents");
    return {
      id: a.id,
      uuid: optUuid(a.uuid, "account_adjustments.uuid"),
      account_id: a.account_id,
      old_balance: a.old_balance,
      new_balance: a.new_balance,
      reason: optStr(a.reason) ?? "",
      ...(isStr(a.created_at) ? { created_at: a.created_at } : {}),
    };
  });
  must(hasUniqueIds(account_adjustments), "account_adjustments.id values must be unique");
  must(hasUniqueUuids(account_adjustments), "account_adjustments.uuid values must be unique");

  const transaction_tags = tableOf(raw, "transaction_tags").map((l): ArchiveTagLink => {
    must(isPositiveId(l.transaction_id) && txIds.has(l.transaction_id), "transaction_tags.transaction_id references a missing transaction");
    must(isPositiveId(l.tag_id) && tagIds.has(l.tag_id), "transaction_tags.tag_id references a missing tag");
    return { transaction_id: l.transaction_id, tag_id: l.tag_id };
  });
  must(
    new Set(transaction_tags.map((link) => `${link.transaction_id}:${link.tag_id}`)).size === transaction_tags.length,
    "transaction_tags entries must be unique",
  );

  return {
    format: ARCHIVE_FORMAT,
    version: ARCHIVE_VERSION,
    exported_at: isStr(raw.exported_at) ? raw.exported_at : new Date().toISOString(),
    accounts,
    categories,
    tags,
    transactions,
    account_adjustments,
    transaction_tags,
  };
}
