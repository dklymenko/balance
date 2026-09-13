import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  addPassphraseWrap, backupKeyFile, beginPassphraseRotation, createKeyFile, dropPassphraseWrap,
  finishPassphraseRotation, generateDbKey, hasKeyFile, isValidDbKey, keyFilePath, keysEqual,
  readKeyFile, restoreKeyFileFromBackup, unwrapWithPassphrase, unwrapWithSafeStorage,
} from "../keyStore";
import type { LockCodec } from "../lockStore";

// Hybrid DB-key wrapping: safeStorage (Keychain/DPAPI) by default; App Lock
// adds an scrypt-passphrase AES-GCM wrap alongside it. Synthetic keys only.

// Stand-in for Electron safeStorage: reversible, obviously not secure.
const xorCodec: LockCodec = {
  encrypt: (s) => Buffer.from([...Buffer.from(s, "utf8")].map((b) => b ^ 0x5a)),
  decrypt: (b) => Buffer.from([...b].map((x) => x ^ 0x5a)).toString("utf8"),
};

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "keystore-"));
  return dir;
}

describe("generateDbKey", () => {
  it("mints 64-hex raw keys, unique per call", () => {
    const a = generateDbKey();
    const b = generateDbKey();
    expect(isValidDbKey(a)).toBe(true);
    expect(isValidDbKey(b)).toBe(true);
    expect(a).not.toBe(b);
  });

  it("rejects malformed keys", () => {
    expect(isValidDbKey("short")).toBe(false);
    expect(isValidDbKey("z".repeat(64))).toBe(false);
    expect(isValidDbKey(42)).toBe(false);
  });
});

describe("safeStorage wrap", () => {
  it("creates, persists, and unwraps a key", () => {
    const dir = scratch();
    const key = createKeyFile(dir, xorCodec);
    expect(key && isValidDbKey(key)).toBe(true);
    expect(hasKeyFile(dir)).toBe(true);
    const file = readKeyFile(dir)!;
    expect(unwrapWithSafeStorage(file, xorCodec)).toBe(key);
    rmSync(dir, { recursive: true, force: true });
  });

  it("backs up and restores the wrapped key without storing a raw database key", () => {
    const dir = scratch();
    const key = createKeyFile(dir, xorCodec)!;
    const backup = backupKeyFile(dir);
    expect(backup).toBe(join(dir, "backups", "dbkey.json"));
    expect(existsSync(backup)).toBe(true);

    writeFileSync(keyFilePath(dir), "corrupt", { mode: 0o600 });
    expect(readKeyFile(dir)).toBeNull();
    expect(restoreKeyFileFromBackup(dir)).toBe(true);
    expect(unwrapWithSafeStorage(readKeyFile(dir)!, xorCodec)).toBe(key);
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns null when the codec cannot decrypt (restored on another machine)", () => {
    const dir = scratch();
    const key = createKeyFile(dir, xorCodec)!;
    const otherCodec: LockCodec = {
      encrypt: (s) => Buffer.from(s),
      decrypt: (b) => b.toString("utf8").split("").reverse().join(""),
    };
    expect(unwrapWithSafeStorage(readKeyFile(dir)!, otherCodec)).toBeNull();
    expect(key).toBeTruthy();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("passphrase wrap (App Lock)", () => {
  it("adds a wrap the right passphrase opens and the wrong one does not", () => {
    const dir = scratch();
    const key = createKeyFile(dir, xorCodec)!;
    addPassphraseWrap(dir, key, "correct horse");
    const file = readKeyFile(dir)!;
    expect(unwrapWithPassphrase(file, "correct horse")).toBe(key);
    expect(unwrapWithPassphrase(file, "wrong horse")).toBeNull();
    // safeStorage wrap survives alongside (Touch ID path).
    expect(unwrapWithSafeStorage(file, xorCodec)).toBe(key);
    rmSync(dir, { recursive: true, force: true });
  });

  it("dropPassphraseWrap reverts to safeStorage-only", () => {
    const dir = scratch();
    const key = createKeyFile(dir, xorCodec)!;
    addPassphraseWrap(dir, key, "pw");
    dropPassphraseWrap(dir);
    const file = readKeyFile(dir)!;
    expect(file.pass).toBeUndefined();
    expect(unwrapWithSafeStorage(file, xorCodec)).toBe(key);
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps the current password recoverable until a password rotation commits", () => {
    const dir = scratch();
    const key = createKeyFile(dir, xorCodec)!;
    addPassphraseWrap(dir, key, "old password");

    beginPassphraseRotation(dir, key, "old password", "new password");
    const inFlight = readKeyFile(dir)!;
    expect(unwrapWithPassphrase(inFlight, "old password")).toBe(key);
    expect(unwrapWithPassphrase(inFlight, "new password")).toBe(key);

    finishPassphraseRotation(dir);
    const committed = readKeyFile(dir)!;
    expect(unwrapWithPassphrase(committed, "old password")).toBeNull();
    expect(unwrapWithPassphrase(committed, "new password")).toBe(key);
    rmSync(dir, { recursive: true, force: true });
  });

  it("retries an interrupted rotation from the password that still gates the app", () => {
    const dir = scratch();
    const key = createKeyFile(dir, xorCodec)!;
    addPassphraseWrap(dir, key, "old password");
    beginPassphraseRotation(dir, key, "old password", "abandoned password");

    beginPassphraseRotation(dir, key, "old password", "final password");
    const retried = readKeyFile(dir)!;
    expect(unwrapWithPassphrase(retried, "old password")).toBe(key);
    expect(unwrapWithPassphrase(retried, "abandoned password")).toBeNull();
    expect(unwrapWithPassphrase(retried, "final password")).toBe(key);
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects attacker-controlled scrypt work factors in a key file", () => {
    const dir = scratch();
    const key = createKeyFile(dir, xorCodec)!;
    addPassphraseWrap(dir, key, "correct horse battery staple");
    const file = readKeyFile(dir)!;
    expect(unwrapWithPassphrase({ ...file, pass: { ...file.pass!, N: 2 ** 30 } }, "anything")).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  it("keysEqual is exact", () => {
    const k = generateDbKey();
    expect(keysEqual(k, k)).toBe(true);
    expect(keysEqual(k, generateDbKey())).toBe(false);
  });
});
