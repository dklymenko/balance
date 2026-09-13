// sync_state kv access: mode, cursor, client_id, household info. Free tier
// never writes 'mode', so getSyncMode defaults to 'local' and the outbox
// stays empty.
import { eq } from "drizzle-orm";
import { syncState } from "./schema.js";
import type { DbExecutor } from "./types.js";

export type SyncMode = "local" | "enrolling" | "cloud";

export function getSyncValue(exec: DbExecutor, key: string): string | null {
  const row = exec.select().from(syncState).where(eq(syncState.key, key)).get();
  return row?.value ?? null;
}

export function setSyncValue(exec: DbExecutor, key: string, value: string): void {
  exec
    .insert(syncState)
    .values({ key, value })
    .onConflictDoUpdate({ target: syncState.key, set: { value } })
    .run();
}

export function deleteSyncValue(exec: DbExecutor, key: string): void {
  exec.delete(syncState).where(eq(syncState.key, key)).run();
}

export function getSyncMode(exec: DbExecutor): SyncMode {
  const value = getSyncValue(exec, "mode");
  return value === "cloud" || value === "enrolling" ? value : "local";
}

export function getCursor(exec: DbExecutor): number {
  const raw = getSyncValue(exec, "cursor");
  const n = raw == null ? 0 : Number(raw);
  return Number.isFinite(n) ? n : 0;
}

export function setCursor(exec: DbExecutor, cursor: number): void {
  setSyncValue(exec, "cursor", String(cursor));
}

export function getClientId(exec: DbExecutor): string | null {
  return getSyncValue(exec, "client_id");
}
