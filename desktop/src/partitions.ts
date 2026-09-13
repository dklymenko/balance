// The app UI keeps only its own harmless browser preferences between runs.
// Third-party sign-in sessions are deliberately memory-only: an Amazon or
// Cloud auth cookie must never be left as plaintext Chromium state on disk.
export const LOCAL_PARTITION = "persist:balance-local";
export const AMAZON_PARTITION = "amazon";
export const CLOUD_AUTH_PARTITION = "balance-cloud-auth";
