// Sync protocol wire types. This file is the contract implemented by every
// Balance sync client and server, so replicas cannot drift apart silently.
// All wire money is integer cents; all entity
// references are uuids (server integer ids never cross the wire).
//
// Validators are hand-rolled (house style -- no schema library): each returns
// the typed value or throws SyncWireError, and is applied to every server
// response before anything touches the local DB.

import type { TransactionType, TransferDirection } from "./finance";

export type SyncEntity =
  | "account"
  | "category"
  | "tag"
  | "transaction"
  | "account_adjustment";

export const SYNC_ENTITIES: readonly SyncEntity[] = [
  "account", "category", "tag", "transaction", "account_adjustment",
];

// ---- Entity payloads (syncable fields only; balances never sync -- they are
// recomputed from the ledger on each side) ----

export interface AccountData {
  name: string;
  account_type: string;
  base_currency: string;
  liquidity_type: string;
  exchange_rate: number;
  ticker: string | null;
  shares_quantity: number | null;
  current_price_usd: number | null; // cents
  sort_order: number | null;
  notes: string | null;
  is_default: boolean;
  is_active: boolean;
  exclude_from_reports: boolean;
  created_at: string;
  updated_at: string;
}

export interface CategoryData {
  name: string;
  parent_uuid: string | null;
  kind: string;
  created_at: string;
}

export interface TagData {
  name: string;
  created_at: string;
}

export interface TransactionData {
  account_uuid: string;
  category_uuid: string | null;
  date: string; // YYYY-MM-DD
  description: string;
  amount_fx: number; // cents
  exchange_rate: number;
  type: TransactionType;
  transfer_group_id: string | null;
  transfer_direction: TransferDirection | null;
  exclude_from_reports: boolean;
  // Tag links replicate as a replace-the-set list on the transaction (matching
  // PUT /api/tags/transaction/:txId semantics) -- naturally LWW, no join-table
  // tombstones.
  tag_uuids: string[];
  created_at: string;
  updated_at: string;
}

export interface AdjustmentData {
  account_uuid: string;
  old_balance: number; // cents, observed on the writing device
  new_balance: number; // cents
  reason: string;
  created_at: string;
}

export type EntityData =
  | AccountData
  | CategoryData
  | TagData
  | TransactionData
  | AdjustmentData;

// ---- Push (device → server) ----

export interface UpsertOp {
  op_id: string;
  type: "upsert";
  entity: SyncEntity;
  uuid: string;
  data: Record<string, unknown>;
}

export interface DeleteOp {
  op_id: string;
  type: "delete";
  entity: SyncEntity;
  uuid: string;
}

// Both legs + directions insert atomically server-side via createTransfer.
// Legs later edited/deleted sync as plain upserts/deletes on their leg uuids.
export interface TransferCreateOp {
  op_id: string;
  type: "transfer_create";
  transfer_group_id: string;
  from_account_uuid: string;
  to_account_uuid: string;
  from_leg_uuid: string;
  to_leg_uuid: string;
  date: string;
  description: string;
  amount: number; // cents
}

// Carries old+new observed on the device -- the delta is frozen client-side;
// the server inserts the adjustment row and recomputes.
export interface AccountAdjustOp {
  op_id: string;
  type: "account_adjust";
  account_uuid: string;
  adjustment_uuid: string;
  old_balance: number; // cents
  new_balance: number; // cents
  reason: string;
}

export type PushOp = UpsertOp | DeleteOp | TransferCreateOp | AccountAdjustOp;

export const PUSH_BATCH_LIMIT = 200;

export interface PushRequest {
  client_id: string;
  base_cursor: number;
  ops: PushOp[];
}

export interface PushConflict {
  reason: "delete_wins" | "stale_overwrite";
  deleted_at?: string;
  deleted_by?: string;
  overwrote_seq?: number;
  overwrote_actor?: string;
}

export interface PushResult {
  op_id: string;
  status: "applied" | "duplicate" | "rejected";
  seq?: number;
  conflict?: PushConflict;
}

export interface PushResponse {
  cursor: number;
  results: PushResult[];
}

// ---- Pull (server → device, coalesced state) ----

export interface PullUpsertChange {
  seq: number;
  entity: SyncEntity;
  uuid: string;
  op: "upsert";
  actor: string | null;
  at: string;
  data: Record<string, unknown>;
}

export interface PullDeleteChange {
  seq: number;
  entity: SyncEntity;
  uuid: string;
  op: "delete";
  actor: string | null;
  at: string;
}

export type PullChange = PullUpsertChange | PullDeleteChange;

export interface PullResponse {
  cursor: number;
  has_more: boolean;
  changes: PullChange[];
}

// ---- Snapshot (new-device hydration) ----

export interface SnapshotResponse {
  cursor: number;
  accounts: ({ uuid: string } & Record<string, unknown>)[];
  categories: ({ uuid: string } & Record<string, unknown>)[];
  tags: ({ uuid: string } & Record<string, unknown>)[];
  transactions: ({ uuid: string } & Record<string, unknown>)[];
  account_adjustments: ({ uuid: string } & Record<string, unknown>)[];
  tx_after: number | null; // pagination handle for the transactions page
  has_more_transactions: boolean;
}

// ---- Validators ----

export class SyncWireError extends Error {}

function must(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new SyncWireError(msg);
}

function isRow(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function isEntity(v: unknown): v is SyncEntity {
  return typeof v === "string" && (SYNC_ENTITIES as string[]).includes(v);
}

export function validatePushResponse(raw: unknown): PushResponse {
  must(isRow(raw), "push response must be an object");
  must(typeof raw.cursor === "number" && Number.isSafeInteger(raw.cursor) && raw.cursor >= 0, "push response cursor must be a non-negative integer");
  must(Array.isArray(raw.results), "push response results must be an array");
  must(raw.results.length <= PUSH_BATCH_LIMIT, "push response exceeds the result limit");
  const results = raw.results.map((r): PushResult => {
    must(isRow(r), "push result must be an object");
    must(typeof r.op_id === "string" && r.op_id.length > 0, "push result op_id is required");
    must(r.status === "applied" || r.status === "duplicate" || r.status === "rejected", "invalid push result status");
    const out: PushResult = { op_id: r.op_id, status: r.status };
    if (typeof r.seq === "number" && Number.isSafeInteger(r.seq) && r.seq >= 0) out.seq = r.seq;
    if (isRow(r.conflict) && (r.conflict.reason === "delete_wins" || r.conflict.reason === "stale_overwrite")) {
      out.conflict = r.conflict as unknown as PushConflict;
    }
    return out;
  });
  must(new Set(results.map((result) => result.op_id)).size === results.length, "push response op_id values must be unique");
  return { cursor: raw.cursor, results };
}

export function validatePullResponse(raw: unknown): PullResponse {
  must(isRow(raw), "pull response must be an object");
  must(typeof raw.cursor === "number" && Number.isSafeInteger(raw.cursor) && raw.cursor >= 0, "pull response cursor must be a non-negative integer");
  must(typeof raw.has_more === "boolean", "pull response has_more must be a boolean");
  must(Array.isArray(raw.changes), "pull response changes must be an array");
  must(raw.changes.length <= 1_000, "pull response exceeds the change limit");
  const changes = raw.changes.map((c): PullChange => {
    must(isRow(c), "pull change must be an object");
    must(typeof c.seq === "number" && Number.isSafeInteger(c.seq) && c.seq >= 0, "pull change seq must be a non-negative integer");
    must(isEntity(c.entity), "pull change entity is invalid");
    must(typeof c.uuid === "string" && c.uuid.length > 0 && c.uuid.length <= 64, "pull change uuid is required");
    const actor = typeof c.actor === "string" ? c.actor : null;
    const at = typeof c.at === "string" ? c.at : "";
    if (c.op === "delete") {
      return { seq: c.seq, entity: c.entity, uuid: c.uuid, op: "delete", actor, at };
    }
    must(c.op === "upsert", "pull change op must be upsert or delete");
    must(isRow(c.data), "pull upsert change requires data");
    return { seq: c.seq, entity: c.entity, uuid: c.uuid, op: "upsert", actor, at, data: c.data };
  });
  return { cursor: raw.cursor, has_more: raw.has_more, changes };
}

export function validateSnapshotResponse(raw: unknown): SnapshotResponse {
  must(isRow(raw), "snapshot must be an object");
  must(typeof raw.cursor === "number" && Number.isSafeInteger(raw.cursor) && raw.cursor >= 0, "snapshot cursor must be a non-negative integer");
  const table = (name: string, limit: number) => {
    const rows = raw[name] ?? [];
    must(Array.isArray(rows), `snapshot ${name} must be an array`);
    must(rows.length <= limit, `snapshot ${name} exceeds the row limit`);
    rows.forEach((r) => must(isRow(r) && typeof r.uuid === "string" && r.uuid.length > 0 && r.uuid.length <= 64, `snapshot ${name} rows require a uuid`));
    return rows as ({ uuid: string } & Record<string, unknown>)[];
  };
  must(typeof raw.has_more_transactions === "boolean", "snapshot has_more_transactions must be a boolean");
  must(raw.tx_after === null || (typeof raw.tx_after === "number" && Number.isSafeInteger(raw.tx_after) && raw.tx_after >= 0), "snapshot tx_after must be null or a non-negative integer");
  return {
    cursor: raw.cursor,
    accounts: table("accounts", 2_000),
    categories: table("categories", 2_000),
    tags: table("tags", 5_000),
    transactions: table("transactions", 1_000),
    account_adjustments: table("account_adjustments", 20_000),
    tx_after: raw.tx_after as number | null,
    has_more_transactions: raw.has_more_transactions,
  };
}
