import type { AmazonOrder } from "./types";

// Runs inside the Amazon page: injected as source text via
// `(${extractOrdersInPage.toString()})(selectors)`, so it MUST stay fully
// self-contained -- no imports, no references to outer-scope bindings. tsc
// (unlike tsx/esbuild) emits arrow constants without helper wrappers, which
// is what makes the .toString() injection safe.
//
// Amazon's order-history HTML changes occasionally -- selectors and the DOM
// walk below are a best-effort against the layout in use as of 2026-05. If
// the scrape returns zero rows after a successful login, inspect
// amazon.com/your-orders/orders in DevTools and update the selectors (served
// centrally in selectors.ts and ship with each reviewed app release).
const extractOrdersInPage = (SEL: { orderCard: string }): {
  amazon_order_id: string | null;
  order_date: string;
  amount_usd: number;
  items: string[];
}[] => {
  const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();

  const parseDate = (raw: string): string | null => {
    const months: Record<string, string> = {
      january: "01", february: "02", march: "03", april: "04", may: "05", june: "06",
      july: "07", august: "08", september: "09", october: "10", november: "11", december: "12",
    };
    const m = raw.toLowerCase().match(/([a-z]+)\s+(\d{1,2}),?\s+(\d{4})/);
    if (!m) return null;
    const month = months[m[1]];
    if (!month) return null;
    return `${m[3]}-${month}-${m[2].padStart(2, "0")}`;
  };

  const parseAmount = (raw: string): number | null => {
    const m = raw.replace(/,/g, "").match(/\$?(\d+(?:\.\d{1,2})?)/);
    return m ? parseFloat(m[1]) : null;
  };

  const out: { amazon_order_id: string | null; order_date: string; amount_usd: number; items: string[] }[] = [];
  for (const card of Array.from(document.querySelectorAll(SEL.orderCard))) {
    const headerText = clean((card.querySelector(".order-info, .a-box-group .a-color-secondary") as HTMLElement | null)?.innerText);
    const dateText = clean((card.querySelector(".a-column.a-span3 .a-size-base, .order-info .a-row:nth-child(1) .a-column:nth-child(1) .a-size-base") as HTMLElement | null)?.innerText) || headerText;
    const totalText = clean((card.querySelector(".a-column.a-span2 .a-size-base, .order-info .a-row:nth-child(1) .a-column:nth-child(2) .a-size-base") as HTMLElement | null)?.innerText);
    const idEl = card.querySelector("[class*='order-id'] bdi, .yohtmlc-order-id bdi, .a-text-right .a-color-secondary bdi");
    const orderId = clean((idEl as HTMLElement | null)?.innerText);

    const items: string[] = [];
    card.querySelectorAll(".a-link-normal").forEach((a) => {
      const href = (a as HTMLAnchorElement).href ?? "";
      if (/\/gp\/product\/|\/dp\//.test(href)) {
        const title = clean((a as HTMLElement).innerText);
        if (title) items.push(title);
      }
    });

    const orderDate = parseDate(dateText) ?? parseDate(headerText);
    const amount = parseAmount(totalText);
    if (!orderDate || amount == null) continue;

    out.push({
      amazon_order_id: orderId || null,
      order_date: orderDate,
      amount_usd: amount,
      items: items.slice(0, 8),
    });
  }
  return out;
};

// Serialized form injected by scraper.ts via webContents.executeJavaScript.
export function extractionScript(orderCardSelector: string): string {
  return `(${extractOrdersInPage.toString()})(${JSON.stringify({ orderCard: orderCardSelector })})`;
}

export type { AmazonOrder };
