import {
  readKeyFile, replaceSafeStorageWrap, unwrapWithPassphrase, unwrapWithSafeStorage,
} from "./keyStore";
import { readLock, writeLock, type LockCodec } from "./lockStore";
import { createVerifier } from "./passlock";

// A lock verifier sealed by safeStorage cannot be read after a profile moves
// to another Mac. The database key's App Lock passphrase wrap is deliberately
// portable, so a correct password can authenticate itself through AES-GCM and
// reseal a fresh verifier for the new Mac without exposing the raw key.
export function recoverLockVerifierFromPassphrase(
  userDataDir: string,
  password: string,
  codec: LockCodec | null,
): boolean {
  const file = readKeyFile(userDataDir);
  const key = file ? unwrapWithPassphrase(file, password) : null;
  if (!key) return false;
  if (codec) replaceSafeStorageWrap(userDataDir, key, codec);
  writeLock(userDataDir, createVerifier(password), codec);
  return true;
}

// Touch ID can open a profile only when this Mac can read both the App Lock
// verifier and (for encrypted ledgers) the safeStorage-wrapped database key.
// Otherwise the password path must run so its portable passphrase wrap can be
// used; accepting a biometric first would close the prompt and strand boot.
export function canUseTouchIdForProfile(
  userDataDir: string,
  codec: LockCodec | null,
  encryptedLedger: boolean,
): boolean {
  if (!codec || !readLock(userDataDir, codec)) return false;
  if (!encryptedLedger) return true;
  const file = readKeyFile(userDataDir);
  return !!file && unwrapWithSafeStorage(file, codec) !== null;
}
