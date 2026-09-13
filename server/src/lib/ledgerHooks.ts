// Change hook: every ledger mutation reports (entity, uuid, op) here after
// its rows are written, inside the same better-sqlite3 transaction. In the
// local-only mode this is a no-op. Balance Desktop's cloud mode installs
// a sink that loads the row by uuid and enqueues the wire op in its sync
// outbox -- which is why completeness matters: any mutation path that skips
// the hook silently breaks replica sync.
//
// The contract is intentionally tiny (ids, not payloads): the sink reads
// current row state itself, so this file carries no sync logic and the local
// server package takes no dependency on the sync client.

export type ChangeEntity = "account" | "category" | "tag" | "transaction" | "account_adjustment";
export type ChangeOp = "upsert" | "delete";

export interface LedgerChange {
  entity: ChangeEntity;
  entityUuid: string;
  op: ChangeOp;
}

export type ChangeSink = (change: LedgerChange) => void;

let sink: ChangeSink = () => {};

export function setChangeSink(next: ChangeSink): void {
  sink = next;
}

export function recordChange(change: LedgerChange): void {
  sink(change);
}
