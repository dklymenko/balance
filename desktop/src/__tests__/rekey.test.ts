import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  canDiscardEncryptionKeyAfterFailure, encryptDbInPlace, isPlaintextSqlite,
  recoverInterruptedEncryption, type SqliteCtor,
} from "../rekey";
import { generateDbKey } from "../keyStore";

// In-place plaintext -> SQLCipher migration. The application dependency is
// built for Electron, while the npm-aliased test dependency is independently
// built for Node so a clean-clone test run exercises the real cipher.

function loadNodeDriver(): SqliteCtor | null {
  // CJS build: plain require; vitest resolves from this file's location.
  for (const candidate of [
    process.env.MC_NODE_PATH,
    "better-sqlite3-multiple-ciphers-node",
    "better-sqlite3-multiple-ciphers",
  ]) {
    if (!candidate) continue;
    try {
      const Ctor = require(candidate) as SqliteCtor;
      // require() only pulls in the JS wrapper. The native binding is opened
      // lazily by the constructor, so an Electron-ABI build fails here rather
      // than above: construct once to prove the build matches this runtime.
      new Ctor(":memory:").close();
      return Ctor;
    } catch {
      // ABI mismatch or not installed: try the next candidate
    }
  }
  return null;
}

const Driver = loadNodeDriver();
const maybe = Driver ? describe : describe.skip;

maybe("encryptDbInPlace", () => {
  function makePlaintextDb(dir: string): string {
    const path = join(dir, "balance.db");
    const db = new Driver!(path);
    // Synthetic values only.
    db.pragma("journal_mode = WAL");
    (db as unknown as { exec(s: string): void }).exec(
      "CREATE TABLE accounts (id INTEGER PRIMARY KEY, name TEXT, balance INTEGER);" +
      "INSERT INTO accounts (name, balance) VALUES ('Synthetic Checking', 12345);",
    );
    db.close();
    return path;
  }

  it("encrypts in place, preserves data, and removes the temporary plaintext recovery copy", () => {
    const dir = mkdtempSync(join(tmpdir(), "rekey-"));
    const path = makePlaintextDb(dir);
    expect(isPlaintextSqlite(path)).toBe(true);

    const key = generateDbKey();
    const result = encryptDbInPlace(path, key, Driver!);
    expect(result.rekeyed).toBe(true);
    expect(existsSync(`${path}.pre-encryption.tmp`)).toBe(false);
    expect(isPlaintextSqlite(path)).toBe(false);
    expect(readFileSync(path).includes(Buffer.from("Synthetic Checking"))).toBe(false);

    // Wrong key cannot open; right key sees the data.
    const wrong = new Driver!(path);
    wrong.pragma(`key="x'${generateDbKey()}'"`);
    expect(() => wrong.prepare("SELECT count(*) n FROM accounts").get()).toThrow();
    wrong.close();

    const right = new Driver!(path);
    right.pragma(`key="x'${key}'"`);
    const row = right.prepare("SELECT name, balance FROM accounts").get() as { name: string; balance: number };
    expect(row).toEqual({ name: "Synthetic Checking", balance: 12345 });
    right.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("no-ops on an already-encrypted or missing file", () => {
    const dir = mkdtempSync(join(tmpdir(), "rekey-"));
    const path = makePlaintextDb(dir);
    const key = generateDbKey();
    encryptDbInPlace(path, key, Driver!);
    // Second run: file no longer plaintext, nothing to do.
    expect(encryptDbInPlace(path, key, Driver!)).toEqual({ rekeyed: false });
    expect(encryptDbInPlace(join(dir, "missing.db"), key, Driver!)).toEqual({ rekeyed: false });
    rmSync(dir, { recursive: true, force: true });
  });

  it("only permits discarding a new key after plaintext recovery is proven", () => {
    const dir = mkdtempSync(join(tmpdir(), "rekey-disposition-"));
    const plain = makePlaintextDb(dir);
    expect(canDiscardEncryptionKeyAfterFailure(plain)).toBe(true);
    encryptDbInPlace(plain, generateDbKey(), Driver!);
    expect(canDiscardEncryptionKeyAfterFailure(plain)).toBe(false);
    expect(canDiscardEncryptionKeyAfterFailure(join(dir, "missing.db"))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("rekey crash safety", () => {
  const magic = Buffer.from("SQLite format 3\0synthetic ledger");

  it("restores the plaintext database and removes the recovery copy when rekey fails", () => {
    const dir = mkdtempSync(join(tmpdir(), "rekey-failure-"));
    const path = join(dir, "balance.db");
    writeFileSync(path, magic);

    class FailingDriver {
      constructor(_path: string) {}
      pragma(source: string) {
        if (source.startsWith("rekey=")) {
          writeFileSync(path, Buffer.from("partially encrypted"));
          throw new Error("synthetic rekey failure");
        }
        return undefined;
      }
      prepare(_source: string) { return { get: () => ({ n: 1 }) }; }
      close() {}
    }

    expect(() => encryptDbInPlace(path, "a".repeat(64), FailingDriver)).toThrow("synthetic rekey failure");
    expect(readFileSync(path)).toEqual(magic);
    expect(existsSync(`${path}.pre-encryption.tmp`)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("recovers a crash-interrupted migration before boot", () => {
    const dir = mkdtempSync(join(tmpdir(), "rekey-recovery-"));
    const path = join(dir, "balance.db");
    writeFileSync(path, Buffer.from("partially encrypted"));
    writeFileSync(`${path}.pre-encryption.tmp`, magic);

    expect(recoverInterruptedEncryption(path)).toBe(true);
    expect(readFileSync(path)).toEqual(magic);
    expect(existsSync(`${path}.pre-encryption.tmp`)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("isPlaintextSqlite", () => {
  it("false for a missing file", () => {
    expect(isPlaintextSqlite("/nonexistent/definitely-not-here.db")).toBe(false);
  });
});
