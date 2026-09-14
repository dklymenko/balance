// Contract between the web client and desktop shell. The preload script
// exposes window.balanceDesktop through Electron's context bridge.

// Matches the server's AmazonOrder (lib/amazonScraper.ts) and the `orders`
// body param of POST /api/imports/amazon-match.
export interface DesktopAmazonOrder {
  amazon_order_id: string | null;
  order_date: string; // YYYY-MM-DD
  amount_usd: number;
  items: string[];
}

export interface ScrapeWindow {
  oldestIso: string; // YYYY-MM-DD, inclusive lower bound
  newestIso: string; // YYYY-MM-DD, inclusive upper bound
}

// Shell app-lock state/controls. All password entry happens in a native
// window owned by the desktop shell; the web page only opens it.
export interface AppLockStatus {
  enabled: boolean;
  touchId: boolean;
}

export interface DesktopAppLock {
  status(): Promise<AppLockStatus>;
  setup(): Promise<AppLockStatus>;
  change(): Promise<AppLockStatus>;
  disable(): Promise<AppLockStatus>;
  lockNow(): Promise<AppLockStatus>;
}

// At-rest encryption state. Opt-in: a new profile is unencrypted until the
// user turns this on, which is what raises the macOS Keychain prompt.
// Reading this never touches the Keychain: whether macOS secure storage works
// is only discovered when the user opts in, and comes back as EncryptionResult
// .error. Probing up front would raise the permission prompt at startup, which
// is what opt-in exists to prevent.
export interface EncryptionStatus {
  encrypted: boolean;
  declined: boolean;
}

export interface EncryptionResult {
  ok: boolean;
  error?: string;
  status: EncryptionStatus;
}

export interface DesktopEncryption {
  status(): Promise<EncryptionStatus>;
  enable(): Promise<EncryptionResult>;
  decline(): Promise<EncryptionStatus>;
}

export interface DesktopCloudStatus {
  mode: "local" | "cloud";
  connecting: boolean;
}

export interface DesktopCloud {
  status(): Promise<DesktopCloudStatus>;
}

export interface DesktopAmazonSession {
  forget(): Promise<{ forgotten: boolean }>;
}

export interface DesktopBridge {
  // Opens the local Amazon window (user signs in there if needed) and
  // resolves with orders whose order_date falls inside the window.
  scrapeAmazon(window: ScrapeWindow): Promise<DesktopAmazonOrder[]>;
  // Controls only the isolated Amazon browser profile. No cookies or tokens
  // cross this bridge.
  amazonSession?: DesktopAmazonSession;
  // Present from desktop v0.3.2 on; optional for older shells.
  appLock?: DesktopAppLock;
  // Present from desktop v0.2.0 on; optional for older shells.
  encryption?: DesktopEncryption;
  // Present from desktop v0.2.0 on. This exposes only profile state, never the
  // Cloud endpoint or session token.
  cloud?: DesktopCloud;
}

declare global {
  interface Window {
    balanceDesktop?: DesktopBridge;
  }
}

export function getDesktopBridge(): DesktopBridge | null {
  return typeof window !== "undefined" && window.balanceDesktop ? window.balanceDesktop : null;
}

// Mirror of the server's scrape-window rule (routes/imports.ts): newest =
// max(date), oldest = min(date) - 90 days, generous because order-placement
// and card-charge dates drift (split shipments, deferred billing).
export const SCRAPE_BACKDATE_DAYS = 90;

export function scrapeWindowFor(dates: string[]): ScrapeWindow | null {
  if (dates.length === 0) return null;
  const sorted = [...dates].sort();
  const newestIso = sorted[sorted.length - 1];
  const d = new Date(sorted[0] + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - SCRAPE_BACKDATE_DAYS);
  return { oldestIso: d.toISOString().slice(0, 10), newestIso };
}

export function getDesktopAppLock(): DesktopAppLock | null {
  return getDesktopBridge()?.appLock ?? null;
}

export function getDesktopEncryption(): DesktopEncryption | null {
  return getDesktopBridge()?.encryption ?? null;
}

export function getDesktopAmazonSession(): DesktopAmazonSession | null {
  return getDesktopBridge()?.amazonSession ?? null;
}
