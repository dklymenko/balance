// Shared Amazon-order types. Production scraping lives exclusively in the
// sandboxed Electron window (desktop/src/scraper.ts), where the user can see
// and control the Amazon session. Server tests inject a synthetic ScrapeFn;
// the normal HTTP server has no browser automation or Amazon credentials.

export interface AmazonOrder {
  amazon_order_id: string | null;
  order_date: string; // YYYY-MM-DD
  amount_usd: number;
  items: string[]; // item titles, kept structured so callers can summarize accurately
}

export type ScrapeFn = (from: Date, to: Date) => Promise<AmazonOrder[]>;
