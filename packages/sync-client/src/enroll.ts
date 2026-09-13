// Enrollment + mode transitions. Three wizard branches:
//   (a) local data + empty household  → uuid-preserving import, adopt cursor
//   (b) fresh device                  → snapshot hydration, adopt cursor
//   (c) local data + non-empty cloud  → "replace local data" or abort
// No merge in v1 -- the empty-household rule makes silent re-merge impossible
// by design.
import { newUuid } from "./uuid.js";
import type { DB, Tx } from "./types.js";
import {
  accounts, accountAdjustments, categories, syncConflicts, syncOutbox, syncState, tags, transactions,
} from "./schema.js";
import { exportArchive, isDbEmpty } from "./archive.js";
import type { SyncApi } from "./api.js";
import type { SnapshotResponse } from "@balance/core";
import { hydrateFromSnapshot } from "./apply.js";
import { clearOutbox, outboxCount } from "./outbox.js";
import { deleteSyncValue, setSyncValue } from "./state.js";

function beginEnrollment(db: DB): string {
  const clientId = newUuid();
  db.transaction((tx: Tx) => {
    clearOutbox(tx);
    setSyncValue(tx, "mode", "enrolling");
    setSyncValue(tx, "client_id", clientId);
  });
  return clientId;
}

function abortEnrollment(db: DB): void {
  db.transaction((tx: Tx) => {
    // Keep operations created while the upload/snapshot was in flight. They
    // prove the ledger changed after the caller's safety backup and prevent a
    // same-attempt replacement from discarding unprotected edits. The next
    // upload starts from a fresh backup + full archive and clears them there.
    deleteSyncValue(tx, "cursor");
    deleteSyncValue(tx, "client_id");
    setSyncValue(tx, "mode", "local");
  });
}

function enterCloudMode(db: DB, cursor: number, clientId: string): void {
  db.transaction((tx: Tx) => {
    setSyncValue(tx, "mode", "cloud");
    setSyncValue(tx, "cursor", String(cursor));
    setSyncValue(tx, "client_id", clientId);
  });
}

type SnapshotRow = { uuid: string } & Record<string, unknown>;

const SNAPSHOT_ROW_LIMITS = {
  accounts: 2_000,
  categories: 2_000,
  tags: 5_000,
  transactions: 200_000,
  account_adjustments: 20_000,
} as const;

function mergeSnapshotRows(
  target: Map<string, SnapshotRow>,
  rows: SnapshotRow[],
  limit: number,
  label: string,
): void {
  for (const row of rows) {
    target.set(row.uuid, row);
    if (target.size > limit) {
      throw new Error(`Cloud snapshot ${label} exceeds the ${limit} row limit`);
    }
  }
}

export async function completeSnapshot(api: SyncApi): Promise<SnapshotResponse> {
  let page = await api.snapshot();
  const cursor = page.cursor;
  const rows = {
    accounts: new Map<string, SnapshotRow>(),
    categories: new Map<string, SnapshotRow>(),
    tags: new Map<string, SnapshotRow>(),
    transactions: new Map<string, SnapshotRow>(),
    account_adjustments: new Map<string, SnapshotRow>(),
  };
  const mergePage = (snapshot: SnapshotResponse) => {
    mergeSnapshotRows(rows.accounts, snapshot.accounts, SNAPSHOT_ROW_LIMITS.accounts, "accounts");
    mergeSnapshotRows(rows.categories, snapshot.categories, SNAPSHOT_ROW_LIMITS.categories, "categories");
    mergeSnapshotRows(rows.tags, snapshot.tags, SNAPSHOT_ROW_LIMITS.tags, "tags");
    mergeSnapshotRows(rows.transactions, snapshot.transactions, SNAPSHOT_ROW_LIMITS.transactions, "transactions");
    mergeSnapshotRows(
      rows.account_adjustments,
      snapshot.account_adjustments,
      SNAPSHOT_ROW_LIMITS.account_adjustments,
      "account adjustments",
    );
  };
  mergePage(page);
  let previousAfter = -1;
  let pages = 1;
  while (page.has_more_transactions) {
    if (page.tx_after == null || page.tx_after <= previousAfter) {
      throw new Error("Cloud snapshot pagination did not advance");
    }
    if (++pages > 1_000) throw new Error("Cloud snapshot exceeded the page limit");
    previousAfter = page.tx_after;
    page = await api.snapshot(page.tx_after);
    if (page.cursor !== cursor) throw new Error("Cloud snapshot changed while it was downloading");
    mergePage(page);
  }
  return {
    cursor,
    accounts: [...rows.accounts.values()],
    categories: [...rows.categories.values()],
    tags: [...rows.tags.values()],
    transactions: [...rows.transactions.values()],
    account_adjustments: [...rows.account_adjustments.values()],
    tx_after: page.tx_after,
    has_more_transactions: false,
  };
}

// Branch (a): migrate the local ledger up. The server must answer 409 for a
// non-empty household -- the wizard then offers branch (c) or aborting.
export async function enrollWithLocalData(db: DB, api: SyncApi): Promise<void> {
  const clientId = beginEnrollment(db);
  try {
    const archive = exportArchive(db);
    const { cursor } = await api.importArchive(archive);
    // Mutations made after export are already queued and will push once cloud
    // mode becomes visible in the same atomic state transition.
    enterCloudMode(db, cursor, clientId);
  } catch (error) {
    abortEnrollment(db);
    throw error;
  }
}

// Branch (b): fresh device joining an existing household.
export async function enrollFresh(db: DB, api: SyncApi): Promise<void> {
  if (!isDbEmpty(db)) throw new Error("enrollFresh requires an empty local ledger");
  const clientId = beginEnrollment(db);
  try {
    const snapshot = await completeSnapshot(api);
    if (!isDbEmpty(db) || outboxCount(db) > 0) {
      throw new Error("Local data changed while Cloud enrollment was in progress; nothing was replaced");
    }
    hydrateFromSnapshot(db, snapshot, { activateClientId: clientId });
  } catch (error) {
    abortEnrollment(db);
    throw error;
  }
}

// Branch (c): user chose "Replace local data with cloud data". The caller is
// responsible for archiving the DB file aside first (app layer, file copy).
export async function replaceLocalWithCloud(db: DB, api: SyncApi): Promise<void> {
  if (outboxCount(db) > 0) {
    throw new Error("Local data changed after the safety backup; reconnect to Cloud to take a fresh backup before replacing it");
  }
  const clientId = beginEnrollment(db);
  try {
    const snapshot = await completeSnapshot(api);
    if (outboxCount(db) > 0) {
      throw new Error("Local data changed while the Cloud copy was downloading; nothing was replaced");
    }
    hydrateFromSnapshot(db, snapshot, { replace: true, activateClientId: clientId });
  } catch (error) {
    abortEnrollment(db);
    throw error;
  }
}

// On a crash, enrollment has not yet reached its single atomic commit. The
// local ledger is therefore authoritative and can safely return to local mode.
export function recoverInterruptedEnrollment(db: DB): boolean {
  const mode = db.select().from(syncState).all().find((row) => row.key === "mode")?.value;
  if (mode !== "enrolling") return false;
  abortEnrollment(db);
  return true;
}

// Order respects FKs; transaction_tags cascade from transactions.
export function wipeLedger(db: DB): void {
  db.transaction((tx: Tx) => {
    tx.delete(transactions).run();
    tx.delete(accountAdjustments).run();
    tx.delete(tags).run();
    tx.delete(categories).run();
    tx.delete(accounts).run();
    tx.delete(syncOutbox).run();
    tx.delete(syncConflicts).run();
  });
}

// Settings → Disconnect: engine has already made its final push attempt.
// All data is kept; re-linking later means replace-or-reset.
export function disconnect(db: DB): void {
  clearOutbox(db);
  deleteSyncValue(db, "cursor");
  deleteSyncValue(db, "client_id");
  setSyncValue(db, "mode", "local");
}
