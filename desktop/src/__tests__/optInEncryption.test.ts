import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { purgePlaintextBackups } from "../backups";
import { encryptDbInPlace, isPlaintextSqlite, type SqliteCtor } from "../rekey";
import { parseConfig } from "../config";

// At-rest encryption is opt-in: a new profile runs unencrypted so nothing
// touches the Keychain before the user has been told what it is for. That
// makes the backup directory a live risk -- snapshots taken before opting in
// are plaintext copies of the entire ledger, and leaving them in place would
// undo the migration.

// CJS build: plain require, same as rekey.test.ts. This is the Node-ABI copy
// of the cipher driver; the Electron-ABI one cannot open under vitest
// (see scripts/native-abi.mjs).
const Driver = require("better-sqlite3-multiple-ciphers-node") as SqliteCtor;
const KEY = "a1b2c3d4".repeat(8);

function seedDb(path: string, marker: string): void {
  const db = new Driver(path) as unknown as { exec(sql: string): void; close(): void };
  db.exec(`CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('${marker}')`);
  db.close();
}

describe("opt-in encryption: plaintext backup purge", () => {
  it("removes plaintext snapshots and keeps encrypted ones", () => {
    const dir = mkdtempSync(join(tmpdir(), "balance-purge-"));
    const backups = join(dir, "backups");
    mkdirSync(backups);

    const plain = join(backups, "balance-2026-01-01T00-00-00.db");
    const encrypted = join(backups, "balance-2026-01-02T00-00-00.db");
    seedDb(plain, "PLAINTEXT-MARKER");
    seedDb(encrypted, "ENCRYPTED-MARKER");
    encryptDbInPlace(encrypted, KEY, Driver);

    // A file that is not a snapshot must never be touched.
    const unrelated = join(backups, "dbkey.json");
    writeFileSync(unrelated, "{}");
    // A user-created database with a Balance-looking prefix is not one of the
    // timestamped snapshots produced by the app and must also be preserved.
    const lookalike = join(backups, "balance-personal-copy.db");
    seedDb(lookalike, "USER-COPY");

    const removed = purgePlaintextBackups(backups);

    expect(removed).toEqual(["balance-2026-01-01T00-00-00.db"]);
    expect(existsSync(plain)).toBe(false);
    expect(existsSync(encrypted)).toBe(true);
    expect(existsSync(unrelated)).toBe(true);
    expect(existsSync(lookalike)).toBe(true);
    expect(isPlaintextSqlite(encrypted)).toBe(false);

    rmSync(dir, { recursive: true, force: true });
  });

  it("is a no-op on a missing or already-encrypted backup directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "balance-purge2-"));
    expect(purgePlaintextBackups(join(dir, "does-not-exist"))).toEqual([]);

    const backups = join(dir, "backups");
    mkdirSync(backups);
    const encrypted = join(backups, "balance-2026-03-03T00-00-00.db");
    seedDb(encrypted, "ONLY-ENCRYPTED");
    encryptDbInPlace(encrypted, KEY, Driver);
    expect(purgePlaintextBackups(backups)).toEqual([]);
    expect(existsSync(encrypted)).toBe(true);

    rmSync(dir, { recursive: true, force: true });
  });
});

describe("opt-in encryption: declined flag", () => {
  it("round-trips encryptionDeclined and defaults to undefined", () => {
    expect(parseConfig(JSON.stringify({ mode: "local" }))?.encryptionDeclined).toBeUndefined();
    expect(parseConfig(JSON.stringify({ mode: "local", encryptionDeclined: true }))?.encryptionDeclined).toBe(true);
    // Only a literal true counts, so a corrupt value cannot suppress the offer.
    expect(parseConfig(JSON.stringify({ mode: "local", encryptionDeclined: "yes" }))?.encryptionDeclined).toBeUndefined();
    expect(parseConfig(JSON.stringify({ mode: "local", encryptionDeclined: 1 }))?.encryptionDeclined).toBeUndefined();
  });
});
