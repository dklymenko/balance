import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { isPlaintextSqlite } from "./rekey";

// Backups are written by the embedded server (online VACUUM INTO snapshots,
// daily at 03:00 plus a catch-up on boot, pruned to the last
// 14) into userData/backups. The shell additionally requests one on quit and
// reads the directory here to surface "Last backup: ..." in the app menu.

// Same shape the server's backup lib writes: balance-<ISO stamp>.db
const BACKUP_FILE_RE = /^balance-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:-\d+)?\.db$/;

export interface BackupInfo {
  file: string;
  mtimeMs: number;
}

export function lastBackup(dir: string): BackupInfo | null {
  if (!existsSync(dir)) return null;
  let newest: BackupInfo | null = null;
  for (const file of readdirSync(dir)) {
    if (!BACKUP_FILE_RE.test(file)) continue;
    const mtimeMs = statSync(join(dir, file)).mtimeMs;
    if (!newest || mtimeMs > newest.mtimeMs) newest = { file, mtimeMs };
  }
  return newest;
}

// Encryption is opt-in, so snapshots taken beforehand are plaintext copies of
// the entire ledger. Once the user opts in they must go, or the migration is
// undone by the backup directory. Only files that are readable plaintext
// SQLite are removed; anything that cannot be classified is left alone rather
// than risking the deletion of an encrypted snapshot. Callers must take a
// fresh encrypted snapshot BEFORE calling this, so there is never a moment
// with no recoverable copy.
export function purgePlaintextBackups(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const removed: string[] = [];
  for (const file of readdirSync(dir)) {
    if (!BACKUP_FILE_RE.test(file)) continue;
    const full = join(dir, file);
    try {
      if (!isPlaintextSqlite(full)) continue;
      rmSync(full, { force: true });
      removed.push(file);
    } catch {
      // Unreadable or vanished: leave it rather than guess.
    }
  }
  return removed;
}

export function formatLastBackup(info: BackupInfo | null, nowMs: number): string {
  if (!info) return "Last backup: never";
  const ageMs = Math.max(0, nowMs - info.mtimeMs);
  const min = Math.floor(ageMs / 60_000);
  if (min < 1) return "Last backup: just now";
  if (min < 60) return `Last backup: ${min} min ago`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `Last backup: ${hours} h ago`;
  const days = Math.floor(hours / 24);
  return `Last backup: ${days} day${days === 1 ? "" : "s"} ago`;
}
