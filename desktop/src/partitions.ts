// Amazon uses its own persistent partition so its Keychain-encrypted cookies
// survive app restarts. Cloud authentication remains memory-only and separate;
// no Amazon browser state is exposed to the UI or sync engine.
export const LOCAL_PARTITION = "persist:balance-local";
export const AMAZON_PARTITION = "persist:balance-amazon";
export const CLOUD_AUTH_PARTITION = "balance-cloud-auth";

// Cookie encryption is an Electron fuse, so it exists in the packaged app but
// not in the stock Electron binary used by `npm run start`. Never persist the
// Amazon session when that protection is unavailable.
export function amazonPartitionFor(isPackaged: boolean): string {
  return isPackaged ? AMAZON_PARTITION : "amazon";
}
