import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parseVerifier, serializeVerifier, type LockVerifier } from "./passlock";
import { writeAtomicFile } from "./atomicFile";

// Persistence for the app-lock verifier: userData/lock.dat. The payload is
// wrapped by a codec -- in the app that is Electron's safeStorage, whose key
// lives in the macOS Keychain, so the file is unreadable outside this user
// account. Lock state is derived from the file's existence (no config flag
// to drift out of sync).

export interface LockCodec {
  encrypt(plaintext: string): Buffer;
  decrypt(ciphertext: Buffer): string;
}

// Fallback when OS encryption is unavailable: the verifier is an scrypt
// hash, so storing it unwrapped is still safe -- wrapping is defense in depth.
export const plainCodec: LockCodec = {
  encrypt: (s) => Buffer.from(s, "utf8"),
  decrypt: (b) => b.toString("utf8"),
};

const MAGIC_WRAPPED = "BLK1:";
const MAGIC_PLAIN = "BLP1:";

export function lockFilePath(userDataDir: string): string {
  return join(userDataDir, "lock.dat");
}

export function isLockEnabled(userDataDir: string): boolean {
  return existsSync(lockFilePath(userDataDir));
}

export function writeLock(userDataDir: string, verifier: LockVerifier, codec: LockCodec | null): void {
  const path = lockFilePath(userDataDir);
  const raw = serializeVerifier(verifier);
  const body = codec
    ? MAGIC_WRAPPED + codec.encrypt(raw).toString("base64")
    : MAGIC_PLAIN + plainCodec.encrypt(raw).toString("base64");
  writeAtomicFile(path, body);
}

export function readLock(userDataDir: string, codec: LockCodec | null): LockVerifier | null {
  try {
    const body = readFileSync(lockFilePath(userDataDir), "utf8").trim();
    if (body.startsWith(MAGIC_WRAPPED)) {
      if (!codec) return null; // wrapped on another install; cannot decrypt
      return parseVerifier(codec.decrypt(Buffer.from(body.slice(MAGIC_WRAPPED.length), "base64")));
    }
    if (body.startsWith(MAGIC_PLAIN)) {
      return parseVerifier(plainCodec.decrypt(Buffer.from(body.slice(MAGIC_PLAIN.length), "base64")));
    }
    return null;
  } catch {
    return null;
  }
}

export function removeLock(userDataDir: string): void {
  rmSync(lockFilePath(userDataDir), { force: true });
}
