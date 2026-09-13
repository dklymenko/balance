// Daily SQLite backup via VACUUM INTO: atomic and consistent on a live WAL
// database, and -- unlike better-sqlite3's .backup() API, which refuses
// mixed-cipher source/target -- it works identically on an encrypted database
// (Balance Desktop), where the snapshot comes out encrypted under the SAME
// key. Backups of an encrypted ledger must never be plaintext.
// Destination dir is read from BACKUP_DIR (set in .env, which is gitignored).
// Old snapshots are pruned to KEEP_COUNT to avoid unbounded disk use.

import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, renameSync, unlinkSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import cron from "node-cron";
import type Database from "better-sqlite3";

const KEEP_COUNT = 14;
const BACKUP_FILE_RE = /^balance-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:-\d+)?\.db$/;

function expandHome(p: string): string {
  return p.startsWith("~") ? resolve(homedir(), p.slice(p[1] === "/" ? 2 : 1)) : resolve(p);
}

let backupQueue: Promise<void> = Promise.resolve();

async function runBackupNow(sqlite: Database.Database, backupDir: string): Promise<string> {
  const dir = expandHome(backupDir);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);

  const stamp = new Date().toISOString().replace(/\..+$/, "").replace(/:/g, "-");
  let suffix = 0;
  let dest = join(dir, `balance-${stamp}.db`);
  // VACUUM INTO refuses to overwrite. Use a numeric suffix when two backup
  // requests land in the same second so the later request is a genuinely new
  // snapshot, not a stale file that merely looks successful.
  while (existsSync(dest)) {
    suffix += 1;
    dest = join(dir, `balance-${stamp}-${suffix}.db`);
  }
  const integrity = sqlite.prepare("PRAGMA quick_check").pluck().get();
  if (integrity !== "ok") throw new Error(`Database integrity check failed: ${String(integrity)}`);

  // Write under a non-backup suffix, flush it, then rename atomically. A crash
  // can leave only an ignored .partial file, never a snapshot that looks valid.
  const partial = join(dir, `.${randomUUID()}.partial`);
  try {
    sqlite.prepare("VACUUM INTO ?").run(partial);
    chmodSync(partial, 0o600);
    const fd = openSync(partial, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(partial, dest);
    const dirFd = openSync(dir, "r");
    try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
  } catch (error) {
    try { unlinkSync(partial); } catch { /* best-effort cleanup */ }
    throw error;
  }

  const snapshots = readdirSync(dir)
    .filter(f => BACKUP_FILE_RE.test(f))
    .map(f => ({ f, mtime: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  for (const old of snapshots.slice(KEEP_COUNT)) {
    try { unlinkSync(join(dir, old.f)); } catch { /* best-effort */ }
  }

  return dest;
}

export function runBackup(sqlite: Database.Database, backupDir: string): Promise<string> {
  const result = backupQueue.then(() => runBackupNow(sqlite, backupDir));
  backupQueue = result.then(() => undefined, () => undefined);
  return result;
}

function newestBackupMtime(dir: string): number | null {
  if (!existsSync(dir)) return null;
  const mtimes = readdirSync(dir)
    .filter(f => BACKUP_FILE_RE.test(f))
    .map(f => statSync(join(dir, f)).mtimeMs);
  return mtimes.length ? Math.max(...mtimes) : null;
}

export function startBackupSchedule(sqlite: Database.Database) {
  const backupDir = process.env.BACKUP_DIR;
  if (!backupDir) {
    console.warn("[backup] BACKUP_DIR not set -- daily backups disabled");
    return;
  }
  const dir = expandHome(backupDir);

  // Catch-up: if the newest snapshot is missing or older than 24h, run one
  // now. Laptops are typically asleep at 03:00, so this is the common path.
  const newest = newestBackupMtime(dir);
  const stale = newest === null || (Date.now() - newest) > 24 * 60 * 60 * 1000;
  if (stale) {
    runBackup(sqlite, backupDir)
      .then(dest => console.log(`[backup] catch-up wrote ${dest}`))
      .catch(err => console.error("[backup] catch-up failed:", err));
  }

  // Daily at 03:00 local time.
  cron.schedule("0 3 * * *", async () => {
    try {
      const dest = await runBackup(sqlite, backupDir);
      console.log(`[backup] wrote ${dest}`);
    } catch (err) {
      console.error("[backup] failed:", err);
    }
  });
  console.log(`[backup] scheduled daily at 03:00 → ${dir}`);
}
