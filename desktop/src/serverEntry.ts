import { join, dirname, sep } from "node:path";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type { AddressInfo } from "node:net";
import { drizzle } from "drizzle-orm/better-sqlite3";
import {
  SyncApi, SyncEngine, enrollFresh, enrollWithLocalData, replaceLocalWithCloud, disconnect,
  recoverInterruptedEnrollment,
  isDbEmpty, outboxCount, getSyncMode, getCursor, syncConflicts,
  accounts as scAccounts, categories as scCategories, tags as scTags,
  transactions as scTransactions, transactionTags as scTransactionTags,
  accountAdjustments as scAccountAdjustments, syncState as scSyncState,
  syncOutbox as scSyncOutbox, syncConflicts as scSyncConflicts,
  enqueueOps, type DB as SyncDB,
} from "@balance/sync-client";
import { buildOpsForChange, type LedgerChange } from "./syncOps";
import { LOCAL_ONLY_SYNC_ENDPOINT } from "./config";

// Entry point forked as an Electron utilityProcess in BOTH modes. It boots
// the embedded @balance/server package (migrations, HTTP app, backups) and
// layers the sync bridge on top. The server's ledger change hook feeds the
// outbox, and @balance/sync-client replicates when the profile is enrolled.
//
// Contract with the shell (localServer.ts):
//   env  DATABASE_URL, PORT, BACKUP_DIR, CLIENT_DIST_PATH   as before
//   env  BALANCE_DB_KEY, BALANCE_SQLITE_DRIVER              at-rest encryption
//   env  BALANCE_SAAS_URL, BALANCE_SYNC_TOKEN               sync endpoint + JWT
//   msg  {type:"backup"} -> {type:"backup-done", path?|error?}
//   msg  {type:"rpc", id, cmd, payload} -> {type:"rpc-result", id, ok, data?|error?}
//   msg  {type:"listening", port}                            once ready
//
// The rpc surface is parentPort-only on purpose: sync control (enroll,
// disconnect, tokens) must never be reachable from web content.

interface ParentPort {
  postMessage(message: unknown): void;
  on(event: "message", listener: (e: { data: unknown }) => void): void;
}

// Under Electron this is utilityProcess.parentPort; under a plain node
// child_process fork (the sync UAT harness) fall back to the process IPC
// channel with the same shape.
function resolveParentPort(): ParentPort | undefined {
  const electronPort = (process as unknown as { parentPort?: ParentPort }).parentPort;
  if (electronPort) return electronPort;
  if (typeof process.send === "function") {
    return {
      postMessage: (message) => process.send!(message),
      on: (_event, listener) => process.on("message", (data) => listener({ data })),
    };
  }
  return undefined;
}
const parentPort = resolveParentPort();

function unpacked(p: string): string {
  const alt = p.replace(`${sep}app.asar${sep}`, `${sep}app.asar.unpacked${sep}`);
  return existsSync(alt) ? alt : p;
}

async function main(): Promise<void> {
  process.env.NODE_ENV ??= "production"; // static client serving in app.ts

  const serverRoot = unpacked(dirname(require.resolve("@balance/server/package.json")));
  process.env.CLIENT_DIST_PATH ??= join(serverRoot, "client-dist");

  // The embedded server is ESM; this entry is CJS, so dynamic import bridges.
  const serverDist = (rel: string) => import(pathToFileURL(join(serverRoot, "dist", rel)).href);
  const { db, sqlite } = await serverDist("db/index.js") as {
    db: unknown;
    sqlite: { close(): void };
  };
  const { createApp } = await serverDist("app.js") as {
    createApp: (
      d: unknown, m?: unknown, s?: unknown, settings?: unknown,
      security?: { localAuthToken?: string },
    ) => { listen: (port: number, host: string, cb: () => void) => import("node:http").Server };
  };
  const { runMigrations } = await serverDist("db/migrate.js") as { runMigrations: (d: unknown) => void };
  const { runBackup, startBackupSchedule } = await serverDist("lib/backup.js") as {
    runBackup: (s: unknown, dir: string) => Promise<string>;
    startBackupSchedule: (s: unknown) => void;
  };
  const { setChangeSink } = await serverDist("lib/ledgerHooks.js") as {
    setChangeSink: (sink: (change: LedgerChange) => void) => void;
  };

  runMigrations(db);

  // Second drizzle wrapper over the SAME connection, bound to the
  // sync-client's canonical device schema (table shapes match the embedded
  // server's by construction -- both use the canonical local schema).
  const syncDb = drizzle(sqlite as never, {
    schema: {
      accounts: scAccounts, categories: scCategories, tags: scTags,
      transactions: scTransactions, transactionTags: scTransactionTags,
      accountAdjustments: scAccountAdjustments, syncState: scSyncState,
      syncOutbox: scSyncOutbox, syncConflicts: scSyncConflicts,
    },
  }) as unknown as SyncDB;

  if (recoverInterruptedEnrollment(syncDb)) {
    console.warn("[sync] recovered an interrupted enrollment; local data was left unchanged");
  }

  let currentToken: string | null = process.env.BALANCE_SYNC_TOKEN || null;
  const saasUrl = process.env.BALANCE_SAAS_URL || "";
  const api = new SyncApi({
    baseUrl: saasUrl || LOCAL_ONLY_SYNC_ENDPOINT,
    getToken: async () => currentToken,
    fetchFn: fetch,
  });
  const engine = new SyncEngine(syncDb, api);

  // Debounced push after local mutations; slow interval as the catch-all
  // (the desktop app is effectively always "foregrounded" while open).
  let debounce: ReturnType<typeof setTimeout> | null = null;
  const scheduleSync = (delayMs = 3_000) => {
    if (!saasUrl || getSyncMode(syncDb) !== "cloud") return;
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      debounce = null;
      void engine.syncNow();
    }, delayMs);
  };
  setInterval(() => scheduleSync(0), 60_000).unref?.();

  // Every ledger mutation lands here inside its own write transaction: the
  // outbox rows commit atomically with the rows they describe.
  setChangeSink((change) => {
    enqueueOps(syncDb, buildOpsForChange(syncDb, change));
    scheduleSync();
  });

  const localAuthToken = process.env.BALANCE_LOCAL_TOKEN;
  if (!localAuthToken || localAuthToken.length < 32) {
    throw new Error("BALANCE_LOCAL_TOKEN is required for the embedded local API");
  }
  const app = createApp(db, undefined, null, undefined, { localAuthToken });

  const server = app.listen(Number(process.env.PORT ?? 0), "127.0.0.1", () => {
    const { port } = server.address() as AddressInfo;
    console.log(`[desktop] Balance server on http://127.0.0.1:${port} (db: ${process.env.DATABASE_URL}${process.env.BALANCE_DB_KEY ? ", encrypted" : ""})`);
    parentPort?.postMessage({ type: "listening", port });
    if (process.env.BACKUP_DIR) startBackupSchedule(sqlite);
    scheduleSync(1_000); // catch up on anything queued while offline
  });

  function syncStatus() {
    return {
      mode: getSyncMode(syncDb),
      cursor: getCursor(syncDb),
      engine: engine.getStatus(),
      pending: outboxCount(syncDb),
      conflicts: syncDb.select().from(syncConflicts).all().length,
      hasToken: !!currentToken,
      saasUrl,
    };
  }

  async function syncOrThrow(): Promise<void> {
    await engine.syncNow({ force: true });
    const status = engine.getStatus();
    if (status.state === "idle") return;
    if (status.state === "auth_required") throw new Error("Sign in to Balance Cloud and try again.");
    if (status.state === "offline") throw new Error("Balance Cloud is unreachable. Check your connection and try again.");
    if (status.state === "error") throw new Error(status.message || "Balance Cloud sync failed.");
    throw new Error("Balance Cloud sync did not finish.");
  }

  async function handleRpc(cmd: string, payload: unknown): Promise<unknown> {
    switch (cmd) {
      case "sync-status":
        return syncStatus();
      case "sync-now":
        await syncOrThrow();
        return syncStatus();
      case "set-token": {
        const token = (payload as { token?: unknown } | undefined)?.token;
        currentToken = typeof token === "string" && token ? token : null;
        if (currentToken) engine.resume();
        return syncStatus();
      }
      case "enroll": {
        if (!currentToken) throw new Error("Sign in first");
        if (isDbEmpty(syncDb)) {
          await enrollFresh(syncDb, api); // fresh replica: hydrate from cloud
        } else {
          await enrollWithLocalData(syncDb, api); // migrate the local ledger up
        }
        await engine.syncNow({ force: true });
        return syncStatus();
      }
      case "enroll-replace": {
        if (!currentToken) throw new Error("Sign in first");
        // The shell has already snapshotted the local DB; replace this Mac's
        // ledger with the cloud copy.
        await replaceLocalWithCloud(syncDb, api);
        await engine.syncNow({ force: true });
        return syncStatus();
      }
      case "disconnect": {
        // A clean push is not enough: require the pull to finish too, otherwise
        // disconnecting while the service is unreachable could strand remote
        // changes outside this Mac's final local copy.
        await syncOrThrow();
        const pending = outboxCount(syncDb);
        if (pending > 0) {
          throw new Error(
            `Cannot disconnect while ${pending} local change${pending === 1 ? " is" : "s are"} still waiting to sync. Reconnect to the internet and try again.`,
          );
        }
        disconnect(syncDb);
        currentToken = null;
        return syncStatus();
      }
      default:
        throw new Error(`Unknown rpc cmd: ${cmd}`);
    }
  }

  parentPort?.on("message", (e) => {
    const msg = e.data as { type?: string; id?: number; cmd?: string; payload?: unknown } | undefined;
    if (msg?.type === "backup") {
      const dir = process.env.BACKUP_DIR;
      if (!dir) return parentPort.postMessage({ type: "backup-done", error: "BACKUP_DIR not set" });
      runBackup(sqlite, dir)
        .then((path) => parentPort.postMessage({ type: "backup-done", path }))
        .catch((err) => parentPort.postMessage({ type: "backup-done", error: String(err) }));
      return;
    }
    if (msg?.type === "rpc" && typeof msg.id === "number" && typeof msg.cmd === "string") {
      const id = msg.id;
      handleRpc(msg.cmd, msg.payload)
        .then((data) => parentPort.postMessage({ type: "rpc-result", id, ok: true, data }))
        .catch((err) => parentPort.postMessage({
          type: "rpc-result", id, ok: false, error: err instanceof Error ? err.message : String(err),
        }));
    }
  });
}

main().catch((err) => {
  console.error("[desktop] server entry failed to boot:", err);
  process.exit(1);
});
