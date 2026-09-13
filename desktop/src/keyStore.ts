import {
  createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual,
} from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { LockCodec } from "./lockStore";
import { supportedScryptParams } from "./passlock";
import { writeAtomicFile } from "./atomicFile";

// At-rest database encryption key (userData/dbkey.json). The SQLite file is
// encrypted with SQLCipher (better-sqlite3-multiple-ciphers) using a random
// 32-byte raw key; what varies is how that key is WRAPPED at rest:
//
// - "safeStorage" wrap (default): sealed by Electron safeStorage, whose key
//   lives in the macOS Keychain / Windows DPAPI. Transparent UX, survives
//   forgotten passwords. Honest limit: on Windows, DPAPI is per-user, so
//   other code running as the same user could unwrap it.
// - "passphrase" wrap (added when App Lock is enabled): AES-256-GCM under an
//   scrypt key derived from the App Lock password (same parameters as
//   passlock.ts, pinned per record). Closes the same-user gap for the
//   password path.
//
// When App Lock is on, BOTH wraps are kept: the password unlock unwraps via
// passphrase (no Keychain trust required), while Touch ID unlock -- which is
// itself Keychain-gated -- uses the safeStorage wrap. Disabling App Lock
// drops the passphrase wrap. Losing every wrap loses the ledger (that is the
// deal with real encryption); the enrolled cloud tier is the recovery path.

const SCRYPT = { N: 65536, r: 8, p: 1, keylen: 32, maxmem: 128 * 1024 * 1024 } as const;

function validBase64Bytes(value: string, bytes: number): boolean {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return false;
  const decoded = Buffer.from(value, "base64");
  return decoded.length === bytes && decoded.toString("base64") === value;
}

export interface PassphraseWrap {
  salt: string;
  nonce: string;
  tag: string;
  data: string;
  N: number;
  r: number;
  p: number;
}

export interface KeyFile {
  v: 1;
  // base64(safeStorage.encryptString(hexKey)); absent when safeStorage was
  // unavailable at write time or the wrap was intentionally dropped.
  safe?: string;
  // AES-256-GCM of the hex key under scrypt(passphrase, salt).
  pass?: PassphraseWrap;
  // Present only while an App Lock password change is crossing the atomic
  // boundary between dbkey.json and lock.dat. It keeps the password that still
  // gates the app able to recover the database key after a crash.
  previousPass?: PassphraseWrap;
}

export function keyFilePath(userDataDir: string): string {
  return join(userDataDir, "dbkey.json");
}

export function keyBackupPath(userDataDir: string): string {
  return join(userDataDir, "backups", "dbkey.json");
}

export function generateDbKey(): string {
  return randomBytes(32).toString("hex"); // 64 hex chars -- raw SQLCipher key
}

export function isValidDbKey(key: unknown): key is string {
  return typeof key === "string" && /^[0-9a-f]{64}$/i.test(key);
}

export function readKeyFile(userDataDir: string): KeyFile | null {
  try {
    const parsed = JSON.parse(readFileSync(keyFilePath(userDataDir), "utf8")) as Partial<KeyFile>;
    if (parsed.v !== 1) return null;
    if (parsed.safe !== undefined && typeof parsed.safe !== "string") return null;
    for (const p of [parsed.pass, parsed.previousPass]) {
      if (p === undefined) continue;
      if (typeof p !== "object" || p === null) return null;
      for (const k of ["salt", "nonce", "tag", "data"] as const) {
        if (typeof p[k] !== "string") return null;
      }
      for (const k of ["N", "r", "p"] as const) {
        if (typeof p[k] !== "number") return null;
      }
      if (!supportedScryptParams(p.N, p.r, p.p)) return null;
      if (!validBase64Bytes(p.salt, 16) || !validBase64Bytes(p.nonce, 12)) return null;
      if (!validBase64Bytes(p.tag, 16) || !validBase64Bytes(p.data, 64)) return null;
    }
    return parsed as KeyFile;
  } catch {
    return null;
  }
}

export function hasKeyFile(userDataDir: string): boolean {
  return existsSync(keyFilePath(userDataDir));
}

function writeKeyFile(userDataDir: string, file: KeyFile): void {
  const path = keyFilePath(userDataDir);
  writeAtomicFile(path, JSON.stringify(file));
}

// Database snapshots remain encrypted with this wrapped key. Keep a validated,
// mode-0600 copy alongside them so a truncated primary key file does not make
// every otherwise healthy backup unusable. This never stores the raw key.
export function backupKeyFile(userDataDir: string): string {
  const file = readKeyFile(userDataDir);
  if (!file) throw new Error("Cannot back up an invalid database key file");
  const path = keyBackupPath(userDataDir);
  writeAtomicFile(path, JSON.stringify(file));
  return path;
}

export function restoreKeyFileFromBackup(userDataDir: string): boolean {
  const file = readKeyFile(join(userDataDir, "backups"));
  if (!file) return false;
  writeKeyFile(userDataDir, file);
  return true;
}

function passphraseWrap(hexKey: string, passphrase: string): PassphraseWrap {
  const salt = randomBytes(16);
  const derived = scryptSync(passphrase, salt, SCRYPT.keylen, SCRYPT);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", derived, nonce);
  const data = Buffer.concat([cipher.update(hexKey, "utf8"), cipher.final()]);
  return {
    salt: salt.toString("base64"),
    nonce: nonce.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
  };
}

function unwrapPassphraseWrap(wrap: PassphraseWrap | undefined, passphrase: string): string | null {
  if (!wrap) return null;
  try {
    const p = wrap;
    if (!supportedScryptParams(p.N, p.r, p.p)) return null;
    const derived = scryptSync(passphrase, Buffer.from(p.salt, "base64"), SCRYPT.keylen, {
      N: p.N, r: p.r, p: p.p, maxmem: SCRYPT.maxmem,
    });
    const decipher = createDecipheriv("aes-256-gcm", derived, Buffer.from(p.nonce, "base64"));
    decipher.setAuthTag(Buffer.from(p.tag, "base64"));
    const hexKey = Buffer.concat([
      decipher.update(Buffer.from(p.data, "base64")),
      decipher.final(), // GCM tag check throws on a wrong passphrase
    ]).toString("utf8");
    return isValidDbKey(hexKey) ? hexKey : null;
  } catch {
    return null;
  }
}

export function unwrapWithPassphrase(file: KeyFile, passphrase: string): string | null {
  return unwrapPassphraseWrap(file.pass, passphrase)
    ?? unwrapPassphraseWrap(file.previousPass, passphrase);
}

export function unwrapWithSafeStorage(file: KeyFile, codec: LockCodec): string | null {
  if (!file.safe) return null;
  try {
    const hexKey = codec.decrypt(Buffer.from(file.safe, "base64"));
    return isValidDbKey(hexKey) ? hexKey : null;
  } catch {
    return null;
  }
}

// Re-seal the portable key for the current OS account after a passphrase
// recovery on another Mac. Keep the passphrase wrap so future moves remain
// recoverable too.
export function replaceSafeStorageWrap(
  userDataDir: string,
  hexKey: string,
  codec: LockCodec,
): void {
  if (!isValidDbKey(hexKey)) throw new Error("invalid database encryption key");
  const existing = readKeyFile(userDataDir);
  if (!existing) throw new Error("Cannot update an invalid database key file");
  writeKeyFile(userDataDir, {
    ...existing,
    safe: codec.encrypt(hexKey).toString("base64"),
  });
}

// First boot of an encrypted profile: mint a key and wrap it with safeStorage.
// A null result is fatal at the shell boundary; Balance never silently falls
// back to a plaintext financial database.
export function createKeyFile(userDataDir: string, codec: LockCodec): string | null {
  const hexKey = generateDbKey();
  try {
    writeKeyFile(userDataDir, { v: 1, safe: codec.encrypt(hexKey).toString("base64") });
    return hexKey;
  } catch {
    return null;
  }
}

// App Lock enabled: add the passphrase wrap (keep safeStorage for Touch ID).
export function addPassphraseWrap(userDataDir: string, hexKey: string, passphrase: string): void {
  const existing = readKeyFile(userDataDir) ?? { v: 1 as const };
  const { previousPass: _previous, ...stable } = existing;
  void _previous;
  writeKeyFile(userDataDir, { ...stable, pass: passphraseWrap(hexKey, passphrase) });
}

// Phase one of an App Lock password change. Both the password that still
// protects lock.dat and the proposed password can unwrap the key until the
// shell atomically replaces the verifier and calls finishPassphraseRotation.
export function beginPassphraseRotation(
  userDataDir: string,
  hexKey: string,
  currentPassphrase: string,
  nextPassphrase: string,
): void {
  const existing = readKeyFile(userDataDir);
  if (!existing) throw new Error("Cannot rotate an invalid database key file");
  writeKeyFile(userDataDir, {
    ...existing,
    pass: passphraseWrap(hexKey, nextPassphrase),
    previousPass: passphraseWrap(hexKey, currentPassphrase),
  });
}

export function finishPassphraseRotation(userDataDir: string): void {
  const existing = readKeyFile(userDataDir);
  if (!existing) throw new Error("Cannot finish rotation of an invalid database key file");
  const { previousPass: _previous, ...committed } = existing;
  void _previous;
  writeKeyFile(userDataDir, committed);
}

// App Lock disabled: back to the transparent safeStorage-only wrap.
export function dropPassphraseWrap(userDataDir: string): void {
  const existing = readKeyFile(userDataDir);
  if (!existing) return;
  const { pass: _dropped, previousPass: _previous, ...rest } = existing;
  void _dropped;
  void _previous;
  writeKeyFile(userDataDir, rest);
}

export function removeKeyFile(userDataDir: string): void {
  rmSync(keyFilePath(userDataDir), { force: true });
}

// Constant-time equality for tests/diagnostics.
export function keysEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
