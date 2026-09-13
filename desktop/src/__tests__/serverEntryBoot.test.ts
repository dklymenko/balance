import { describe, expect, it, beforeAll } from "vitest";
import { fork, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// Regression: nothing exercised the embedded server's actual boot sequence, so
// a placeholder Cloud endpoint that failed SyncApi's own validation shipped
// undetected and killed the app on launch in local-only mode -- the default
// path. Unit tests of the individual modules all passed. This forks the real
// entry point and waits for it to report a port, which is the only assertion
// that would have caught it.
//
// serverEntry falls back to process IPC when Electron's parentPort is absent
// (see resolveParentPort), so it can be driven by a plain Node fork here. The
// SQLite driver is pointed at the Node-ABI build of the cipher driver, because
// the Electron-ABI copy cannot be opened by vitest.

// CJS build: __dirname is desktop/src/__tests__.
const desktopRoot = join(__dirname, "..", "..");
const entry = join(desktopRoot, "dist", "serverEntry.js");
const driver = dirname(require.resolve("better-sqlite3-multiple-ciphers-node/package.json"));
const TOKEN = "t".repeat(64);
const KEY = "a1b2c3d4".repeat(8);

beforeAll(() => {
  if (!existsSync(entry)) {
    throw new Error(
      `${entry} is missing. The desktop boot test runs against build output; run "npm run build" first ` +
      `("npm run verify" builds before testing).`,
    );
  }
});

interface BootResult {
  port?: number;
  exitCode?: number | null;
  stderr: string;
}

// Boots the real entry point and resolves once it reports a listening port or
// dies, whichever happens first.
function boot(env: Record<string, string>, dbPath: string, backupDir: string): Promise<BootResult> {
  return new Promise((resolve) => {
    let child: ChildProcess | null = fork(entry, [], {
      env: {
        ...process.env,
        DATABASE_URL: dbPath,
        BACKUP_DIR: backupDir,
        PORT: "0",
        NODE_ENV: "production",
        BALANCE_LOCAL_TOKEN: TOKEN,
        BALANCE_SQLITE_DRIVER: driver,
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    let stderr = "";
    child.stderr?.on("data", (d: Buffer) => { stderr += String(d); });

    const done = (result: BootResult) => {
      const target = child;
      child = null;
      if (target && !target.killed) target.kill();
      resolve(result);
    };
    const timer = setTimeout(() => done({ stderr: `${stderr}\n(timed out waiting for a port)` }), 25_000);

    child.on("message", (raw: unknown) => {
      const msg = raw as { type?: string; port?: number };
      if (msg?.type === "listening") {
        clearTimeout(timer);
        done({ port: msg.port, stderr });
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      done({ exitCode: code, stderr });
    });
  });
}

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "balance-boot-"));
  const backups = join(dir, "backups");
  mkdirSync(backups);
  return { dir, dbPath: join(dir, "balance.db"), backups };
}

describe("embedded server boot", () => {
  it("starts and listens in local-only mode with no Cloud configured", async () => {
    const { dir, dbPath, backups } = scratch();
    const result = await boot({}, dbPath, backups);
    rmSync(dir, { recursive: true, force: true });

    expect(result.stderr).not.toMatch(/failed to boot/);
    expect(result.exitCode).toBeUndefined();
    expect(result.port).toBeGreaterThan(0);
  }, 30_000);

  it("starts and listens with an encrypted ledger", async () => {
    const { dir, dbPath, backups } = scratch();
    const result = await boot({ BALANCE_DB_KEY: KEY }, dbPath, backups);
    rmSync(dir, { recursive: true, force: true });

    expect(result.stderr).not.toMatch(/failed to boot/);
    expect(result.port).toBeGreaterThan(0);
  }, 30_000);

  it("refuses to start when the local API token is missing", async () => {
    const { dir, dbPath, backups } = scratch();
    const result = await boot({ BALANCE_LOCAL_TOKEN: "" }, dbPath, backups);
    rmSync(dir, { recursive: true, force: true });

    expect(result.port).toBeUndefined();
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/BALANCE_LOCAL_TOKEN/);
  }, 30_000);
});
