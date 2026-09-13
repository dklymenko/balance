// Archive v1 export for the device ledger: the uuid-extended
// archive that enrollment POSTs to /api/sync/import -- the server preserves
// the uuids, so every local row acquires server identity with nothing
// re-downloaded.
import { asc, inArray } from "drizzle-orm";
import {
  accounts, accountAdjustments, categories, tags, transactions, transactionTags,
} from "./schema.js";
import type { DB } from "./types.js";
import { ARCHIVE_FORMAT, ARCHIVE_VERSION, type BalanceArchive } from "@balance/core";

export function exportArchive(db: DB): BalanceArchive {
  const acc = db.select().from(accounts).orderBy(asc(accounts.id)).all();
  const cats = db.select().from(categories).orderBy(asc(categories.id)).all();
  const tagRows = db.select().from(tags).orderBy(asc(tags.id)).all();
  const txs = db.select().from(transactions).orderBy(asc(transactions.id)).all();
  const adj = db.select().from(accountAdjustments).orderBy(asc(accountAdjustments.id)).all();
  const txIds = txs.map((t) => t.id);
  const txTags = txIds.length
    ? db.select().from(transactionTags).where(inArray(transactionTags.transaction_id, txIds)).all()
    : [];

  return {
    format: ARCHIVE_FORMAT,
    version: ARCHIVE_VERSION,
    exported_at: new Date().toISOString(),
    accounts: acc,
    categories: cats,
    tags: tagRows,
    transactions: txs,
    account_adjustments: adj,
    transaction_tags: txTags,
  };
}

export function isDbEmpty(db: DB): boolean {
  return (
    !db.select({ id: accounts.id }).from(accounts).limit(1).get() &&
    !db.select({ id: categories.id }).from(categories).limit(1).get() &&
    !db.select({ id: tags.id }).from(tags).limit(1).get() &&
    !db.select({ id: transactions.id }).from(transactions).limit(1).get()
  );
}
