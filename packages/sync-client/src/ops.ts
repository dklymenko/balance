// Builders that turn local rows into wire PushOps (uuid-only, integer cents).
// The repo layer calls these at mutation time -- inside the same SQLite
// transaction as the rows they describe -- so the outbox can never disagree
// with the ledger.
import type {
  AccountAdjustOp,
  DeleteOp,
  PushOp,
  SyncEntity,
  TransferCreateOp,
  UpsertOp,
} from "@balance/core";
import type { accounts, accountAdjustments, categories, tags, transactions } from "./schema.js";
import { newUuid } from "./uuid.js";

type AccountRow = typeof accounts.$inferSelect;
type CategoryRow = typeof categories.$inferSelect;
type TagRow = typeof tags.$inferSelect;
type TransactionRow = typeof transactions.$inferSelect;
type AdjustmentRow = typeof accountAdjustments.$inferSelect;

// Balances never cross the wire -- they are recomputed from replicated state
// on each side under the frozen-delta model.
export function upsertAccountOp(row: AccountRow): UpsertOp {
  return {
    op_id: newUuid(),
    type: "upsert",
    entity: "account",
    uuid: row.uuid,
    data: {
      name: row.name,
      account_type: row.account_type,
      base_currency: row.base_currency,
      liquidity_type: row.liquidity_type,
      exchange_rate: row.exchange_rate,
      ticker: row.ticker,
      shares_quantity: row.shares_quantity,
      current_price_usd: row.current_price_usd,
      sort_order: row.sort_order,
      notes: row.notes,
      is_default: row.is_default,
      is_active: row.is_active,
      exclude_from_reports: row.exclude_from_reports,
      created_at: row.created_at,
      updated_at: row.updated_at,
    },
  };
}

export function upsertCategoryOp(row: CategoryRow, parentUuid: string | null): UpsertOp {
  return {
    op_id: newUuid(),
    type: "upsert",
    entity: "category",
    uuid: row.uuid,
    data: {
      name: row.name,
      parent_uuid: parentUuid,
      kind: row.kind,
      created_at: row.created_at,
    },
  };
}

export function upsertTagOp(row: TagRow): UpsertOp {
  return {
    op_id: newUuid(),
    type: "upsert",
    entity: "tag",
    uuid: row.uuid,
    data: { name: row.name, created_at: row.created_at },
  };
}

export function upsertTransactionOp(
  row: TransactionRow,
  accountUuid: string,
  categoryUuid: string | null,
  tagUuids: string[],
): UpsertOp {
  return {
    op_id: newUuid(),
    type: "upsert",
    entity: "transaction",
    uuid: row.uuid,
    data: {
      account_uuid: accountUuid,
      category_uuid: categoryUuid,
      date: row.date,
      description: row.description,
      amount_fx: row.amount_fx,
      exchange_rate: row.exchange_rate,
      type: row.type,
      transfer_group_id: row.transfer_group_id,
      transfer_direction: row.transfer_direction,
      exclude_from_reports: row.exclude_from_reports,
      tag_uuids: tagUuids,
      created_at: row.created_at,
      updated_at: row.updated_at,
    },
  };
}

export function accountAdjustOp(accountUuid: string, adj: AdjustmentRow): AccountAdjustOp {
  return {
    op_id: newUuid(),
    type: "account_adjust",
    account_uuid: accountUuid,
    adjustment_uuid: adj.uuid,
    old_balance: adj.old_balance,
    new_balance: adj.new_balance,
    reason: adj.reason,
  };
}

export function transferCreateOp(args: {
  transferGroupId: string;
  fromAccountUuid: string;
  toAccountUuid: string;
  fromLegUuid: string;
  toLegUuid: string;
  date: string;
  description: string;
  amountCents: number;
}): TransferCreateOp {
  return {
    op_id: newUuid(),
    type: "transfer_create",
    transfer_group_id: args.transferGroupId,
    from_account_uuid: args.fromAccountUuid,
    to_account_uuid: args.toAccountUuid,
    from_leg_uuid: args.fromLegUuid,
    to_leg_uuid: args.toLegUuid,
    date: args.date,
    description: args.description,
    amount: args.amountCents,
  };
}

export function deleteEntityOp(entity: SyncEntity, uuid: string): DeleteOp {
  return { op_id: newUuid(), type: "delete", entity, uuid };
}

// The outbox stores (entity, entity_uuid) alongside the payload so screens can
// show what is pending without parsing every op.
export function opEntityRef(op: PushOp): { entity: SyncEntity; entity_uuid: string } {
  switch (op.type) {
    case "upsert":
    case "delete":
      return { entity: op.entity, entity_uuid: op.uuid };
    case "transfer_create":
      return { entity: "transaction", entity_uuid: op.from_leg_uuid };
    case "account_adjust":
      return { entity: "account_adjustment", entity_uuid: op.adjustment_uuid };
  }
}
