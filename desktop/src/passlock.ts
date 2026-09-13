import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

// App-lock password verifier: scrypt(password, salt) with the parameters
// pinned per record so they can be raised later without breaking existing
// locks. Only this verifier is ever persisted (wrapped with safeStorage --
// Keychain-backed on macOS); the password itself never touches disk.

export interface LockVerifier {
  v: 1;
  salt: string; // base64, 16 bytes
  hash: string; // base64, 32 bytes
  N: number;
  r: number;
  p: number;
}

const SCRYPT = { N: 65536, r: 8, p: 1, keylen: 32, maxmem: 128 * 1024 * 1024 } as const;

// Accept the original record parameters for seamless upgrades and the current
// stronger parameters. Reject arbitrary work factors before calling scrypt so
// a corrupt or locally tampered lock file cannot force unbounded CPU/memory.
export function supportedScryptParams(N: number, r: number, p: number): boolean {
  return (N === 16384 || N === 65536) && r === 8 && p === 1;
}

function validBase64Bytes(value: string, bytes: number): boolean {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return false;
  const decoded = Buffer.from(value, "base64");
  return decoded.length === bytes && decoded.toString("base64") === value;
}

export function createVerifier(password: string): LockVerifier {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT.keylen, SCRYPT);
  return {
    v: 1,
    salt: salt.toString("base64"),
    hash: hash.toString("base64"),
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
  };
}

export function verifyPassword(password: string, verifier: LockVerifier): boolean {
  try {
    if (!supportedScryptParams(verifier.N, verifier.r, verifier.p)) return false;
    if (!validBase64Bytes(verifier.salt, 16) || !validBase64Bytes(verifier.hash, 32)) return false;
    const salt = Buffer.from(verifier.salt, "base64");
    const expected = Buffer.from(verifier.hash, "base64");
    const actual = scryptSync(password, salt, expected.length, {
      N: verifier.N, r: verifier.r, p: verifier.p, maxmem: SCRYPT.maxmem,
    });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function serializeVerifier(verifier: LockVerifier): string {
  return JSON.stringify(verifier);
}

export function parseVerifier(raw: string): LockVerifier | null {
  try {
    const parsed = JSON.parse(raw) as Partial<LockVerifier>;
    if (parsed.v !== 1) return null;
    if (typeof parsed.salt !== "string" || typeof parsed.hash !== "string") return null;
    if (typeof parsed.N !== "number" || typeof parsed.r !== "number" || typeof parsed.p !== "number") return null;
    if (!supportedScryptParams(parsed.N, parsed.r, parsed.p)) return null;
    if (!validBase64Bytes(parsed.salt, 16) || !validBase64Bytes(parsed.hash, 32)) return null;
    return parsed as LockVerifier;
  } catch {
    return null;
  }
}
