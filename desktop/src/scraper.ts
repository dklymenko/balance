import { app, BrowserWindow } from "electron";
import { extractionScript } from "./extract";
import { loadSelectors } from "./selectors";
import type { AmazonOrder, ScrapeWindow } from "./types";
import { isAmazonNavigation } from "./navigation";
import { amazonPartitionFor } from "./partitions";
import { flushAmazonSignIn } from "./amazonSession";

// The scrape window is a real, visible browser the user signs in to; the
// packaged app's isolated session persists between runs. Cookie values are
// encrypted by Chromium using macOS Keychain-backed OS cryptography and never
// enter the Balance UI, ledger, or sync engine. Development runs stay in memory.

const ORDER_HISTORY_URL = "https://www.amazon.com/your-orders/orders";
// Amazon paginates via ?startIndex=N (0-based, 10 per page).
const PAGE_SIZE = 10;
const MAX_PAGES = 30; // hard cap so we don't loop forever
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000; // 5 min for the user to type credentials + 2FA
const POLL_INTERVAL_MS = 1000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function scrapeAmazonOrders(w: ScrapeWindow): Promise<AmazonOrder[]> {
  const selectors = loadSelectors();
  const amazonPartition = amazonPartitionFor(app.isPackaged);

  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    title: "Balance -- Amazon order sync",
    webPreferences: {
      partition: amazonPartition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: !app.isPackaged,
    },
  });

  const blockNonAmazon = (event: Electron.Event, url: string) => {
    if (!isAmazonNavigation(url)) event.preventDefault();
  };
  win.webContents.on("will-navigate", blockNonAmazon);
  win.webContents.on("will-redirect", blockNonAmazon);
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  const amazonSession = win.webContents.session;

  try {
    const collected: AmazonOrder[] = [];
    for (let pageNum = 0; pageNum < MAX_PAGES; pageNum++) {
      const startIndex = pageNum * PAGE_SIZE;
      const url = startIndex === 0 ? ORDER_HISTORY_URL : `${ORDER_HISTORY_URL}?startIndex=${startIndex}`;
      await win.loadURL(url);
      await waitForOrdersPage(win, selectors.ordersContainer);

      const orders: AmazonOrder[] = await win.webContents.executeJavaScript(
        extractionScript(selectors.orderCard),
      );
      if (orders.length === 0) break;

      let oldestOnPage: string | null = null;
      for (const o of orders) {
        if (!oldestOnPage || o.order_date < oldestOnPage) oldestOnPage = o.order_date;
        if (o.order_date < w.oldestIso) continue;
        if (o.order_date > w.newestIso) continue;
        collected.push(o);
      }
      // Pages are newest-first; once a page reaches past the window's lower
      // bound there is nothing older worth fetching.
      if (oldestOnPage && oldestOnPage < w.oldestIso) break;
    }

    return collected;
  } finally {
    try {
      await flushAmazonSignIn(amazonSession);
    } finally {
      if (!win.isDestroyed()) win.destroy();
    }
  }
}

// After load, either the orders list is visible (signed in) or Amazon's
// sign-in form is. The user logs in interactively in this window -- poll until
// the orders page is genuinely ready. Amazon redirects back to the requested
// page after login, so no extra navigation is needed.
//
// "Container element exists" is NOT readiness: a signed-out load of the
// orders URL briefly renders markup that satisfies the selector before a
// client-side redirect lands on the sign-in flow, which made the scraper
// return zero orders instantly. Ready therefore means: not inside the /ap/
// sign-in flow, the container is visible (has layout boxes), and the same
// URL reported ready on two consecutive polls (kills the pre-redirect race).
function readyCheckScript(containerSelector: string): string {
  return `(() => {
    if (!(location.protocol === "https:" &&
          (location.hostname === "amazon.com" || location.hostname.endsWith(".amazon.com")))) return null;
    if (location.pathname.startsWith("/ap/")) return null;
    const el = document.querySelector(${JSON.stringify(containerSelector)});
    if (!el || el.getClientRects().length === 0) return null;
    return location.href;
  })()`;
}

async function waitForOrdersPage(win: BrowserWindow, containerSelector: string): Promise<void> {
  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  let readyAt: string | null = null;
  while (Date.now() < deadline) {
    if (win.isDestroyed()) {
      throw new Error("The Amazon window was closed before the order list appeared.");
    }
    const href: string | null = await win.webContents
      .executeJavaScript(readyCheckScript(containerSelector))
      .catch(() => null); // navigation in flight -- try again next tick
    if (href !== null && href === readyAt) return;
    readyAt = href;
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error("Timed out waiting for the Amazon order list. Sign in within 5 minutes and try again.");
}
