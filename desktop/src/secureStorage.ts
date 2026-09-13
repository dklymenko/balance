import type { LockCodec } from "./lockStore";

// Electron's safeStorage calls are synchronous and may ask macOS for Keychain
// permission. Do not call isEncryptionAvailable() as a preflight: on macOS the
// probe itself can prompt, turning one consented operation into two prompts.
// Attempt only the operation the user requested and handle failure there.
export interface SecureStorage {
  encryptString(plaintext: string): Buffer;
  decryptString(ciphertext: Buffer): string;
}

export function secureStorageCodec(storage: SecureStorage): LockCodec {
  return {
    encrypt: (plaintext) => storage.encryptString(plaintext),
    decrypt: (ciphertext) => storage.decryptString(ciphertext),
  };
}

export function wrapSecret(storage: SecureStorage, plaintext: string): string | null {
  try {
    return storage.encryptString(plaintext).toString("base64");
  } catch {
    return null;
  }
}

export function unwrapSecret(storage: SecureStorage, wrapped: string): string | null {
  try {
    return storage.decryptString(Buffer.from(wrapped, "base64"));
  } catch {
    return null;
  }
}
