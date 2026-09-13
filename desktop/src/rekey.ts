import { chmodSync, copyFileSync, existsSync, openSync, readSync, closeSync, rmSync } from "node:fs";

// One-time in-place encryption of an existing plaintext balance.db
// (SQLite3MultipleCiphers: PRAGMA rekey on an unencrypted database encrypts
// every page). The driver constructor is injected: the Electron main process
// passes better-sqlite3-multiple-ciphers built for the Electron ABI; tests
// pass a Node-ABI build.

// Minimal constructor surface of better-sqlite3(-multiple-ciphers).
export type SqliteCtor = new (path: string) => {
  pragma(source: string): unknown;
  prepare(source: string): { get(): unknown };
  close(): void;
};

const SQLITE_MAGIC = "SQLite format 3\0";

// An encrypted database has no readable header; a plaintext one starts with
// the SQLite magic. A missing file needs no rekey (created encrypted).
export function isPlaintextSqlite(path: string): boolean {
  if (!existsSync(path)) return false;
  const fd = openSync(path, "r");
  try {
    const header = Buffer.alloc(16);
    const read = readSync(fd, header, 0, 16, 0);
    return read === 16 && header.toString("latin1") === SQLITE_MAGIC;
  } finally {
    closeSync(fd);
  }
}

// A newly minted wrapped key is disposable only after recovery has positively
// established that the live database is plaintext. Missing or ciphertext data
// may still need that key after a double failure, so fail toward recoverability.
export function canDiscardEncryptionKeyAfterFailure(dbPath: string): boolean {
  return existsSync(dbPath) && isPlaintextSqlite(dbPath);
}

export interface RekeyResult {
  rekeyed: boolean;
}

function recoveryPath(dbPath: string): string {
  return `${dbPath}.pre-encryption.tmp`;
}

function restoreRecoveryCopy(dbPath: string): void {
  const recovery = recoveryPath(dbPath);
  copyFileSync(recovery, dbPath);
  chmodSync(dbPath, 0o600);
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(recovery, { force: true });
}

// If the process died after writing the recovery copy but before completing
// and cleaning up the rekey, restore plaintext before normal key resolution.
// A fully plaintext database means the crash preceded mutation, so only the
// redundant copy needs removing.
export function recoverInterruptedEncryption(dbPath: string): boolean {
  const recovery = recoveryPath(dbPath);
  if (!existsSync(recovery)) return false;
  if (!isPlaintextSqlite(recovery)) {
    throw new Error(`Encryption recovery file is invalid: ${recovery}`);
  }
  if (isPlaintextSqlite(dbPath)) {
    rmSync(recovery, { force: true });
    return false;
  }
  restoreRecoveryCopy(dbPath);
  return true;
}

// Encrypt dbPath in place under hexKey. A mode-0600 plaintext recovery copy
// exists only for the duration of the migration. Every failure path restores
// it, and successful verification removes it before the app starts.
export function encryptDbInPlace(dbPath: string, hexKey: string, Database: SqliteCtor): RekeyResult {
  if (!isPlaintextSqlite(dbPath)) return { rekeyed: false };
  if (!/^[0-9a-f]{64}$/i.test(hexKey)) throw new Error("invalid database encryption key");

  recoverInterruptedEncryption(dbPath);
  const recovery = recoveryPath(dbPath);

  // Fold WAL data into the database before taking the recovery copy. Copying
  // only the main file while live transactions remained in WAL could lose the
  // newest records if a rekey failed.
  const prep = new Database(dbPath);
  try {
    prep.pragma("wal_checkpoint(TRUNCATE)");
    prep.pragma("journal_mode = DELETE");
  } finally {
    prep.close();
  }
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  copyFileSync(dbPath, recovery);
  chmodSync(recovery, 0o600);

  try {
    const db = new Database(dbPath);
    try {
      db.pragma(`rekey="x'${hexKey}'"`);
    } finally {
      db.close();
    }
    rmSync(`${dbPath}-wal`, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });

    // Verify both that the plaintext header disappeared and that the supplied
    // key can execute a real query before destroying the recovery copy.
    if (isPlaintextSqlite(dbPath)) {
      throw new Error("rekey left the database readable without a key");
    }
    const check = new Database(dbPath);
    try {
      check.pragma(`key="x'${hexKey}'"`);
      const row = check.prepare("SELECT count(*) AS n FROM sqlite_master").get() as { n: number };
      if (typeof row?.n !== "number") throw new Error("post-rekey verification query failed");
    } finally {
      check.close();
    }
  } catch (error) {
    try {
      restoreRecoveryCopy(dbPath);
    } catch (restoreError) {
      throw new Error(
        `Database encryption failed and automatic recovery also failed. Recovery copy: ${recovery}. ` +
        `Original error: ${String(error)}. Recovery error: ${String(restoreError)}`,
      );
    }
    throw error;
  }

  rmSync(recovery, { force: true });
  return { rekeyed: true };
}
