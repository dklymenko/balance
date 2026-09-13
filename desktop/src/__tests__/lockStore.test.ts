import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createVerifier, verifyPassword } from "../passlock";
import { isLockEnabled, lockFilePath, plainCodec, readLock, removeLock, writeLock, type LockCodec } from "../lockStore";

// XOR "cipher" standing in for safeStorage in tests -- proves the wrapped
// path round-trips and that a wrapped file is unreadable without its codec.
const xorCodec: LockCodec = {
  encrypt: (s) => Buffer.from(Buffer.from(s, "utf8").map((b) => b ^ 0x5a)),
  decrypt: (b) => Buffer.from(b.map((x) => x ^ 0x5a)).toString("utf8"),
};

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "balance-lock-"));
}

describe("lockStore", () => {
  it("derives enabled-state from the file and round-trips a wrapped verifier", () => {
    const dir = tmp();
    try {
      expect(isLockEnabled(dir)).toBe(false);
      writeLock(dir, createVerifier("open sesame"), xorCodec);
      expect(isLockEnabled(dir)).toBe(true);

      const restored = readLock(dir, xorCodec);
      expect(restored).not.toBeNull();
      expect(verifyPassword("open sesame", restored!)).toBe(true);

      removeLock(dir);
      expect(isLockEnabled(dir)).toBe(false);
      expect(readLock(dir, xorCodec)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to the plain format when no codec is available", () => {
    const dir = tmp();
    try {
      writeLock(dir, createVerifier("pw"), null);
      const restored = readLock(dir, null);
      expect(restored).not.toBeNull();
      expect(verifyPassword("pw", restored!)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a wrapped file when the codec is missing, and tolerates garbage", () => {
    const dir = tmp();
    try {
      writeLock(dir, createVerifier("pw"), xorCodec);
      expect(readLock(dir, null)).toBeNull(); // wrapped, no codec -> unreadable
      writeFileSync(lockFilePath(dir), "garbage");
      expect(readLock(dir, xorCodec)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
