import { eq } from "drizzle-orm";
import {
  accounts, accountAdjustments, categories, tags, transactions, transactionTags,
  accountAdjustOp, deleteEntityOp, upsertAccountOp, upsertCategoryOp, upsertTagOp, upsertTransactionOp,
  type DB,
} from "@balance/sync-client";
import type { PushOp } from "@balance/core";

// Bridge from the embedded server's ledger change hook to sync wire ops.
// The hook reports (entity, uuid, op) synchronously inside the server's
// write transaction; this loads the current row state and builds the op the
// engine will push. Runs on the same better-sqlite3 connection, so the
// outbox row commits atomically with the mutation it describes.
//
// Transfers surface as two plain transaction upserts (each leg carries its
// group id + direction) -- the server's push handler accepts either shape.

export interface LedgerChange {
  entity: "account" | "category" | "tag" | "transaction" | "account_adjustment";
  entityUuid: string;
  op: "upsert" | "delete";
}

export function buildOpsForChange(db: DB, change: LedgerChange): PushOp[] {
  if (change.op === "delete") {
    return [deleteEntityOp(change.entity, change.entityUuid)];
  }

  switch (change.entity) {
    case "account": {
      const row = db.select().from(accounts).where(eq(accounts.uuid, change.entityUuid)).get();
      return row ? [upsertAccountOp(row)] : [];
    }
    case "category": {
      const row = db.select().from(categories).where(eq(categories.uuid, change.entityUuid)).get();
      if (!row) return [];
      const parent = row.parent_id != null
        ? db.select({ uuid: categories.uuid }).from(categories).where(eq(categories.id, row.parent_id)).get()
        : undefined;
      return [upsertCategoryOp(row, parent?.uuid ?? null)];
    }
    case "tag": {
      const row = db.select().from(tags).where(eq(tags.uuid, change.entityUuid)).get();
      return row ? [upsertTagOp(row)] : [];
    }
    case "transaction": {
      const row = db.select().from(transactions).where(eq(transactions.uuid, change.entityUuid)).get();
      if (!row) return [];
      const account = db.select({ uuid: accounts.uuid }).from(accounts).where(eq(accounts.id, row.account_id)).get();
      if (!account) return [];
      const category = row.category_id != null
        ? db.select({ uuid: categories.uuid }).from(categories).where(eq(categories.id, row.category_id)).get()
        : undefined;
      const tagUuids = db
        .select({ uuid: tags.uuid })
        .from(transactionTags)
        .innerJoin(tags, eq(transactionTags.tag_id, tags.id))
        .where(eq(transactionTags.transaction_id, row.id))
        .all()
        .map((t) => t.uuid);
      return [upsertTransactionOp(row, account.uuid, category?.uuid ?? null, tagUuids)];
    }
    case "account_adjustment": {
      const row = db.select().from(accountAdjustments).where(eq(accountAdjustments.uuid, change.entityUuid)).get();
      if (!row) return [];
      const account = db.select({ uuid: accounts.uuid }).from(accounts).where(eq(accounts.id, row.account_id)).get();
      return account ? [accountAdjustOp(account.uuid, row)] : [];
    }
  }
}
