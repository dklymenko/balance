import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addPassphraseWrap, createKeyFile } from "../keyStore";
import { canUseTouchIdForProfile, recoverLockVerifierFromPassphrase } from "../lockRecovery";
import { createVerifier, verifyPassword } from "../passlock";
import { readLock, writeLock, type LockCodec } from "../lockStore";

const codec = (mask: number): LockCodec => ({
  encrypt: (value) => Buffer.from(Buffer.from(value, "utf8").map((byte) => byte ^ mask)),
  decrypt: (value) => Buffer.from(value.map((byte) => byte ^ mask)).toString("utf8"),
});

describe("portable App Lock recovery", () => {
  it("recovers an unreadable Keychain-wrapped verifier using the database passphrase wrap", () => {
    const dir = mkdtempSync(join(tmpdir(), "balance-lock-recovery-"));
    const originalMac = codec(0x5a);
    const restoredMac = codec(0x33);
    const password = "correct horse battery staple";
    try {
      const key = createKeyFile(dir, originalMac)!;
      addPassphraseWrap(dir, key, password);
      writeLock(dir, createVerifier(password), originalMac);

      expect(readLock(dir, restoredMac)).toBeNull();
      expect(canUseTouchIdForProfile(dir, restoredMac, true)).toBe(false);
      expect(canUseTouchIdForProfile(dir, originalMac, true)).toBe(true);
      expect(recoverLockVerifierFromPassphrase(dir, "wrong password", restoredMac)).toBe(false);
      expect(readLock(dir, restoredMac)).toBeNull();
      expect(recoverLockVerifierFromPassphrase(dir, password, restoredMac)).toBe(true);
      expect(verifyPassword(password, readLock(dir, restoredMac)!)).toBe(true);
      expect(canUseTouchIdForProfile(dir, restoredMac, true)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
