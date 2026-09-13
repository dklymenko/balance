// Sync engine: single-flight loop -- push outbox in ≤200-op
// batches, pull until has_more=false, recompute + notify. Triggers live in
// the app layer (foreground, connectivity regained, 3s-debounced local
// mutation, pull-to-refresh, background task); the engine only knows how to
// run one sync safely.
import { PUSH_BATCH_LIMIT, type PushOp } from "@balance/core";
import { syncConflicts } from "./schema.js";
import type { DB } from "./types.js";
import { SyncApi, SyncApiError } from "./api.js";
import { getClientId, getCursor, getSyncMode, setCursor } from "./state.js";
import { outboxCount, pendingOps, recordFailure, removeOps } from "./outbox.js";

export type SyncStatus =
  | { state: "idle"; lastSyncAt: string | null; pending: number }
  | { state: "syncing"; lastSyncAt: string | null; pending: number }
  | { state: "offline"; lastSyncAt: string | null; pending: number }
  | { state: "auth_required"; lastSyncAt: string | null; pending: number }
  | { state: "error"; lastSyncAt: string | null; pending: number; message: string };

type Listener = () => void;

const MAX_BACKOFF_MS = 5 * 60 * 1000;

export class SyncEngine {
  private db: DB;
  private api: SyncApi;
  private running: Promise<void> | null = null;
  private listeners = new Set<Listener>();
  private backoffMs = 0;
  private nextAllowedAt = 0;
  private status: SyncStatus = { state: "idle", lastSyncAt: null, pending: 0 };

  constructor(db: DB, api: SyncApi) {
    this.db = db;
    this.api = api;
  }

  getStatus(): SyncStatus {
    return this.status;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private setStatus(status: SyncStatus): void {
    this.status = status;
    for (const fn of this.listeners) fn();
  }

  private pending(): number {
    return outboxCount(this.db);
  }

  // After a re-auth the banner action calls this to lift the freeze.
  resume(): void {
    this.backoffMs = 0;
    this.nextAllowedAt = 0;
    if (this.status.state === "auth_required" || this.status.state === "error") {
      this.setStatus({ ...this.status, state: "idle" });
    }
  }

  // Single-flight: concurrent triggers coalesce onto the in-flight run.
  syncNow(opts: { force?: boolean } = {}): Promise<void> {
    if (this.running) return this.running;
    if (getSyncMode(this.db) !== "cloud") return Promise.resolve();
    if (this.status.state === "auth_required" && !opts.force) return Promise.resolve();
    if (!opts.force && Date.now() < this.nextAllowedAt) return Promise.resolve();

    this.running = this.run()
      .catch(() => {
        // status already reflects the failure; never throw into a trigger
      })
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }

  private async run(): Promise<void> {
    const lastSyncAt = this.status.lastSyncAt;
    this.setStatus({ state: "syncing", lastSyncAt, pending: this.pending() });
    try {
      await this.pushAll();
      await this.pullAll();
      this.backoffMs = 0;
      this.nextAllowedAt = 0;
      this.setStatus({ state: "idle", lastSyncAt: new Date().toISOString(), pending: this.pending() });
    } catch (err) {
      if (err instanceof SyncApiError && err.status === 401) {
        // Freeze: outbox preserved; op_ids make post-re-auth replay
        // idempotent after authentication resumes.
        this.setStatus({ state: "auth_required", lastSyncAt, pending: this.pending() });
        return;
      }
      this.backoffMs = Math.min(this.backoffMs === 0 ? 5_000 : this.backoffMs * 2, MAX_BACKOFF_MS);
      this.nextAllowedAt = Date.now() + this.backoffMs;
      const message = err instanceof Error ? err.message : String(err);
      const state = err instanceof TypeError ? "offline" : "error"; // fetch network failures surface as TypeError
      if (state === "offline") this.setStatus({ state, lastSyncAt, pending: this.pending() });
      else this.setStatus({ state: "error", lastSyncAt, pending: this.pending(), message });
      throw err;
    }
  }

  private async pushAll(): Promise<void> {
    const clientId = getClientId(this.db);
    if (!clientId) return; // not enrolled
    for (;;) {
      const batch = pendingOps(this.db, PUSH_BATCH_LIMIT);
      if (batch.length === 0) return;
      const ops: PushOp[] = batch.map((b) => b.op);
      const opIds = batch.map((b) => b.op_id);
      let response;
      try {
        response = await this.api.push(clientId, getCursor(this.db), ops);
      } catch (err) {
        if (!(err instanceof SyncApiError && err.status === 401)) {
          recordFailure(this.db, opIds, err instanceof Error ? err.message : String(err));
        }
        throw err;
      }

      const expected = new Set(opIds);
      if (response.results.some((result) => !expected.has(result.op_id))) {
        throw new Error("Cloud push response referenced an unknown operation");
      }

      // Per-op outcomes: applied/duplicate → dequeue; rejected → dequeue and
      // surface in the Activity screen; the next pull repairs local state.
      const done: string[] = [];
      for (const result of response.results) {
        done.push(result.op_id);
        if (result.status === "rejected") {
          const source = batch.find((b) => b.op_id === result.op_id);
          this.db
            .insert(syncConflicts)
            .values({
              entity: source ? opEntity(source.op) : "transaction",
              entity_uuid: source ? opUuid(source.op) : "",
              reason: result.conflict?.reason ?? "rejected",
              detail: JSON.stringify(result.conflict ?? {}),
            })
            .run();
        }
      }
      removeOps(this.db, done);
      // Ops the server did not answer for stay queued and retry next run.
      if (response.results.length < ops.length) return;
    }
  }

  private async pullAll(): Promise<void> {
    // Import of ./apply here would be fine too; kept lazy-free for clarity.
    const { applyPullPage } = await import("./apply.js");
    let pages = 0;
    for (;;) {
      if (++pages > 10_000) throw new Error("Cloud pull exceeded the page limit");
      const cursor = getCursor(this.db);
      const page = await this.api.pull(cursor);
      if (page.cursor < cursor || (page.has_more && page.cursor === cursor)) {
        throw new Error("Cloud pull cursor did not advance");
      }
      if (page.changes.length > 0) {
        applyPullPage(this.db, page.changes, page.cursor);
      } else if (page.cursor !== cursor) {
        setCursor(this.db, page.cursor);
      }
      if (!page.has_more) return;
    }
  }
}

function opEntity(op: PushOp): string {
  return op.type === "upsert" || op.type === "delete"
    ? op.entity
    : op.type === "transfer_create"
      ? "transaction"
      : "account_adjustment";
}

function opUuid(op: PushOp): string {
  return op.type === "upsert" || op.type === "delete"
    ? op.uuid
    : op.type === "transfer_create"
      ? op.from_leg_uuid
      : op.adjustment_uuid;
}
