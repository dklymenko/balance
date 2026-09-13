import { useSyncExternalStore } from "react";

// Personal "advanced / experimental" feature gate. Stored per-browser in
// localStorage so power-user features (recently-added filter, exclude-from-reports,
// existing-ledger imports, …) stay out of most users'
// way while remaining one toggle away in Settings. This is UI decluttering, not
// security.
const KEY = "balance-advanced-features";
const EVENT = "balance-advanced-features-change";

export function getAdvancedFeatures(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function setAdvancedFeatures(on: boolean): void {
  try {
    if (on) localStorage.setItem(KEY, "1");
    else localStorage.removeItem(KEY);
  } catch {
    // storage unavailable -- still fire the event for the current session
  }
  window.dispatchEvent(new Event(EVENT));
}

function subscribe(cb: () => void): () => void {
  window.addEventListener(EVENT, cb);
  window.addEventListener("storage", cb);
  return () => {
    window.removeEventListener(EVENT, cb);
    window.removeEventListener("storage", cb);
  };
}

// Re-renders when the toggle changes (same tab via a custom event, other tabs
// via the native storage event).
export function useAdvancedFeatures(): boolean {
  return useSyncExternalStore(subscribe, getAdvancedFeatures, () => false);
}
