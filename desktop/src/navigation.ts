export function externalHttpsUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

export function isAllowedShellNavigation(
  raw: string,
  appOrigin: string,
  syncOrigin: string,
  allowSyncAuth: boolean,
): boolean {
  try {
    const url = new URL(raw);
    if (url.username || url.password) return false;
    if (appOrigin && url.origin === appOrigin) return true;
    if (!allowSyncAuth) return false;
    if (syncOrigin && url.origin === syncOrigin) return true;
    return url.protocol === "https:" && url.hostname === "accounts.google.com";
  } catch {
    return false;
  }
}

export async function loadUrlWithRetry(
  load: () => Promise<unknown>,
  retryDelayMs = 100,
): Promise<void> {
  try {
    await load();
    return;
  } catch {
    // Chromium can abort the first navigation while a freshly created
    // partition finishes initializing. One bounded retry prevents a silent
    // blank window without hiding a persistent packaging/server failure.
  }
  if (retryDelayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
  }
  await load();
}

export function isAmazonNavigation(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && !url.username && !url.password &&
      (url.hostname === "amazon.com" || url.hostname.endsWith(".amazon.com"));
  } catch {
    return false;
  }
}

export function desktopAuthCode(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "balance-desktop:" || url.hostname !== "auth" ||
        (url.pathname !== "" && url.pathname !== "/") || url.username || url.password || url.search) {
      return null;
    }
    const code = new URLSearchParams(url.hash.slice(1)).get("code");
    return code && code.length <= 4096 ? code : null;
  } catch {
    return null;
  }
}
