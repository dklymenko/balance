// Outbox: local mutations queue here (cloud mode only) and drain via the sync
// engine in arrival order. Enqueued inside the same SQLite transaction as the
// ledger writes they describe -- a crash can never leave rows without their
// ops or ops without their rows.
import { inArray, sql } from "drizzle-orm";
import { syncOutbox } from "./schema.js";
import type { DbExecutor } from "./types.js";
import type { PushOp } from "@balance/core";
import { getSyncMode } from "./state.js";
import { opEntityRef } from "./ops.js";

// No-op only in local mode. During enrollment, mutations are queued so the
// upload cannot silently omit edits made while a network request is in flight.
export function enqueueOps(exec: DbExecutor, ops: PushOp[]): void {
  if (ops.length === 0 || getSyncMode(exec) === "local") return;
  exec
    .insert(syncOutbox)
    .values(
      ops.map((op) => {
        const ref = opEntityRef(op);
        return {
          op_id: op.op_id,
          entity: ref.entity,
          entity_uuid: ref.entity_uuid,
          type: op.type,
          payload: JSON.stringify(op),
        };
      }),
    )
    .run();
}

export interface PendingOp {
  op_id: string;
  attempts: number;
  op: PushOp;
}

// Oldest first: the queue replays in the order the user made the edits.
// rowid, not created_at -- ops enqueued within the same millisecond must still
// drain in insertion order (an account upsert must reach the server before
// the transaction that references it).
export function pendingOps(exec: DbExecutor, limit: number): PendingOp[] {
  const rows = exec
    .select()
    .from(syncOutbox)
    .orderBy(sql`rowid`)
    .limit(limit)
    .all();
  return rows.map((r) => ({ op_id: r.op_id, attempts: r.attempts, op: JSON.parse(r.payload) as PushOp }));
}

export function outboxCount(exec: DbExecutor): number {
  return exec.select().from(syncOutbox).all().length;
}

export function removeOps(exec: DbExecutor, opIds: string[]): void {
  if (opIds.length === 0) return;
  exec.delete(syncOutbox).where(inArray(syncOutbox.op_id, opIds)).run();
}

export function recordFailure(exec: DbExecutor, opIds: string[], error: string): void {
  if (opIds.length === 0) return;
  const rows = exec.select().from(syncOutbox).where(inArray(syncOutbox.op_id, opIds)).all();
  for (const row of rows) {
    exec
      .update(syncOutbox)
      .set({ attempts: row.attempts + 1, last_error: error.slice(0, 500) })
      .where(inArray(syncOutbox.op_id, [row.op_id]))
      .run();
  }
}

export function clearOutbox(exec: DbExecutor): void {
  exec.delete(syncOutbox).run();
}
