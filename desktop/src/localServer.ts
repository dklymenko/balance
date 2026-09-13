import { dirname, join, sep } from "node:path";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import type { UtilityProcess } from "electron";

// Boots the workspace's embedded server as an Electron utilityProcess and
// speaks its contract:
// env vars in ({DATABASE_URL, BACKUP_DIR, PORT: "0", NODE_ENV}), messages out
// ({type:"listening",port} once ready; {type:"backup-done",path|error} after
// a requested backup).

export type ServerMessage =
  | { type: "listening"; port: number }
  | { type: "backup-done"; path?: string; error?: string }
  | { type: "rpc-result"; id: number; ok: boolean; data?: unknown; error?: string };

export function parseServerMessage(raw: unknown): ServerMessage | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { type, port, path, error, id, ok, data } = raw as Record<string, unknown>;
  if (type === "listening") {
    if (typeof port !== "number" || !Number.isInteger(port) || port <= 0 || port > 65535) return null;
    return { type: "listening", port };
  }
  if (type === "backup-done") {
    return {
      type: "backup-done",
      ...(typeof path === "string" ? { path } : {}),
      ...(typeof error === "string" ? { error } : {}),
    };
  }
  if (type === "rpc-result") {
    if (typeof id !== "number" || typeof ok !== "boolean") return null;
    return {
      type: "rpc-result", id, ok, data,
      ...(typeof error === "string" ? { error } : {}),
    };
  }
  return null;
}

export interface ServerEnvOpts {
  dbPath: string;
  backupDir: string;
  // Random per launch. The renderer receives it only through request-header
  // injection for the exact loopback origin, never through JavaScript, a URL,
  // or a cookie shared with other localhost ports.
  localAuthToken?: string;
  // SQLite driver: absolute path to the better-sqlite3-multiple-ciphers build,
  // always supplied by the shell. dbKey is the 64-hex raw key and turns on
  // at-rest encryption (SQLCipher); without it the same driver opens the file
  // as plaintext.
  dbKey?: string;
  sqliteDriverPath?: string;
  // Cloud mode: the sync engine inside the server process needs its HTTPS
  // endpoint and a session token.
  saasUrl?: string;
  syncToken?: string;
}

export function buildServerEnv(opts: ServerEnvOpts): Record<string, string> {
  return {
    DATABASE_URL: opts.dbPath,
    BACKUP_DIR: opts.backupDir,
    PORT: "0", // kernel-assigned; the child reports the real port back
    NODE_ENV: "production", // embedded server serves the built client
    ...(opts.localAuthToken ? { BALANCE_LOCAL_TOKEN: opts.localAuthToken } : {}),
    ...(opts.dbKey ? { BALANCE_DB_KEY: opts.dbKey } : {}),
    ...(opts.sqliteDriverPath ? { BALANCE_SQLITE_DRIVER: opts.sqliteDriverPath } : {}),
    ...(opts.saasUrl ? { BALANCE_SAAS_URL: opts.saasUrl } : {}),
    ...(opts.syncToken ? { BALANCE_SYNC_TOKEN: opts.syncToken } : {}),
  };
}

// Resolve an installed workspace package root. Inside a packaged app the
// package is unpacked from the asar (asarUnpack in electron-builder.yml)
// because the child needs real files: .sql migrations, the client build,
// and the native sqlite binding.
export function resolvePackageRoot(pkg: string): string {
  const pkgRoot = dirname(require.resolve(`${pkg}/package.json`));
  const unpacked = pkgRoot.replace(`${sep}app.asar${sep}`, `${sep}app.asar.unpacked${sep}`);
  return existsSync(unpacked) ? unpacked : pkgRoot;
}

// The desktop entry boots the embedded server and adds the sync bridge.
export function resolveServerEntry(): string {
  const unpacked = __dirname.replace(`${sep}app.asar${sep}`, `${sep}app.asar.unpacked${sep}`);
  const root = existsSync(unpacked) ? unpacked : __dirname;
  return join(root, "serverEntry.js");
}

export interface LocalServer {
  port: number;
  origin: string;
  requestBackup(): Promise<string>;
  // Correlated request/response to the server process (sync control surface:
  // status / sync-now / enroll / disconnect / set-token). Never exposed to
  // web content -- parentPort only.
  request(cmd: string, payload?: unknown, timeoutMs?: number): Promise<unknown>;
  stop(): Promise<void>;
}

const BOOT_TIMEOUT_MS = 20_000;
const BACKUP_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 5_000;

interface StoppableProcess {
  kill(): boolean;
  once(event: "exit", listener: (code: number) => void): unknown;
  removeListener(event: "exit", listener: (code: number) => void): unknown;
}

// UtilityProcess.kill() only requests termination. Rekeying while the child
// still holds SQLite open can race active statements or WAL cleanup, so callers
// that need exclusive DB access must await the actual exit event.
export function stopUtilityProcess(child: StoppableProcess, timeoutMs = STOP_TIMEOUT_MS): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener("exit", onExit);
      if (error) reject(error); else resolve();
    };
    const onExit = () => finish();
    const timer = setTimeout(() => finish(new Error("Embedded server did not exit after termination was requested")), timeoutMs);
    child.once("exit", onExit);
    if (!child.kill()) finish();
  });
}

export function startLocalServer(opts: ServerEnvOpts & { entry: string }): Promise<LocalServer> {
  // Loaded lazily so the pure helpers above stay importable under vitest.
  const { utilityProcess } = require("electron") as typeof import("electron");

  mkdirSync(dirname(opts.dbPath), { recursive: true, mode: 0o700 });
  mkdirSync(opts.backupDir, { recursive: true, mode: 0o700 });
  chmodSync(dirname(opts.dbPath), 0o700);
  chmodSync(opts.backupDir, 0o700);

  return new Promise<LocalServer>((resolve, reject) => {
    const child: UtilityProcess = utilityProcess.fork(opts.entry, [], {
      serviceName: "balance-local-server",
      stdio: "pipe",
      env: { ...process.env, ...buildServerEnv(opts) },
    });
    child.stdout?.on("data", (d: Buffer) => console.log(`[local-server] ${String(d).trimEnd()}`));
    child.stderr?.on("data", (d: Buffer) => console.error(`[local-server] ${String(d).trimEnd()}`));

    let booted = false;
    let stopping = false;
    const bootTimer = setTimeout(() => {
      if (!booted) {
        child.kill();
        reject(new Error(`Embedded server did not report a port within ${BOOT_TIMEOUT_MS / 1000}s`));
      }
    }, BOOT_TIMEOUT_MS);

    let backupWaiter: { resolve(path: string): void; reject(err: Error): void } | null = null;
    let rpcSeq = 0;
    const rpcWaiters = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();

    child.on("message", (raw: unknown) => {
      const msg = parseServerMessage(raw);
      if (!msg) return;
      if (msg.type === "listening" && !booted) {
        booted = true;
        clearTimeout(bootTimer);
        resolve({
          port: msg.port,
          origin: `http://127.0.0.1:${msg.port}`,
          requestBackup: () =>
            new Promise<string>((res, rej) => {
              if (backupWaiter) return rej(new Error("A backup is already in flight"));
              const t = setTimeout(() => {
                backupWaiter = null;
                rej(new Error("Backup timed out"));
              }, BACKUP_TIMEOUT_MS);
              backupWaiter = {
                resolve: (p) => { clearTimeout(t); backupWaiter = null; res(p); },
                reject: (e) => { clearTimeout(t); backupWaiter = null; rej(e); },
              };
              child.postMessage({ type: "backup" });
            }),
          request: (cmd, payload, timeoutMs = 120_000) =>
            new Promise((res, rej) => {
              const id = ++rpcSeq;
              const t = setTimeout(() => {
                rpcWaiters.delete(id);
                rej(new Error(`${cmd} timed out`));
              }, timeoutMs);
              rpcWaiters.set(id, {
                resolve: (v) => { clearTimeout(t); rpcWaiters.delete(id); res(v); },
                reject: (e) => { clearTimeout(t); rpcWaiters.delete(id); rej(e); },
              });
              child.postMessage({ type: "rpc", id, cmd, payload });
            }),
          stop: () => {
            stopping = true;
            return stopUtilityProcess(child);
          },
        });
      } else if (msg.type === "backup-done" && backupWaiter) {
        if (msg.error) backupWaiter.reject(new Error(msg.error));
        else backupWaiter.resolve(msg.path ?? "");
      } else if (msg.type === "rpc-result") {
        const waiter = rpcWaiters.get(msg.id);
        if (waiter) {
          if (msg.ok) waiter.resolve(msg.data);
          else waiter.reject(new Error(msg.error ?? "rpc failed"));
        }
      }
    });

    child.on("exit", (code) => {
      if (!booted) {
        clearTimeout(bootTimer);
        reject(new Error(`Embedded server exited with code ${code} before listening`));
      } else if (!stopping) {
        console.error(`[local-server] exited with code ${code}`);
      }
      backupWaiter?.reject(new Error("Server exited during backup"));
      for (const waiter of rpcWaiters.values()) waiter.reject(new Error("Server exited during request"));
      rpcWaiters.clear();
    });
  });
}
