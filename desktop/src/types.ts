// Contract mirror of client/src/lib/desktopBridge.ts. The same shape is
// accepted by POST /api/imports/amazon-match as the `orders` body param.

export interface AmazonOrder {
  amazon_order_id: string | null;
  order_date: string; // YYYY-MM-DD
  amount_usd: number;
  items: string[];
}

export interface ScrapeWindow {
  oldestIso: string; // YYYY-MM-DD, inclusive lower bound
  newestIso: string; // YYYY-MM-DD, inclusive upper bound
}

export interface AmazonSelectors {
  ordersContainer: string;
  orderCard: string;
}

// window.balanceDesktop.appLock -- drives the shell's app lock from the web
// Settings page. All password entry happens in a native window; these calls
// only open it / report state.
export interface AppLockStatus {
  enabled: boolean;
  touchId: boolean;
}
