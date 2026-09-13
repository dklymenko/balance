// UUID source with an injectable implementation. Modern Node and Electron use
// WebCrypto's randomUUID on globalThis; tests or future runtimes can install a
// compatible implementation without coupling the sync layer to a platform.

let impl: (() => string) | null =
  typeof globalThis.crypto?.randomUUID === "function"
    ? () => globalThis.crypto.randomUUID()
    : null;

export function setUuidSource(fn: () => string) {
  impl = fn;
}

export function newUuid(): string {
  if (!impl) throw new Error("uuid source not configured -- call setUuidSource() at startup");
  return impl();
}
