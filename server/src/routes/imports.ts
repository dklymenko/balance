import { Router } from "express";
import { eq } from "drizzle-orm";
import type { DrizzleDB } from "../db/types.js";
import { amazonOrders } from "../db/schema.js";
import type { ScrapeFn, AmazonOrder } from "../lib/amazonScraper.js";
import type { LocalSettings } from "../lib/localSettings.js";
import { toCents as dollarsToCents } from "../lib/finance.js";

interface PreviewRow {
  date: string;       // YYYY-MM-DD
  amount: string;     // absolute value as string
  description: string;
  type: "debit" | "credit";
  _id?: string;       // optional client-supplied row id, echoed back on match
}

// A matched candidate. The full item list is returned for in-process display
// only; the client persists `summary` (compact) to keep the DB small.
interface Match {
  _id: string | null;
  index: number;      // position in the input rows array
  summary: string;    // e.g. "Echo Dot (5th Gen) (+3 more)"
  items: string[];    // full item titles, not saved to the DB
}

const AMAZON_RE = /amazon|amzn/i;
// Amazon order-placement and credit-card-charge dates can drift significantly
// (split shipments, deferred billing, slow shipping, Subscribe & Save), so
// be generous on both window sizes.
const MATCH_WINDOW_DAYS = 60;
const SCRAPE_BACKDATE_DAYS = 90;

// Preview rows carry amounts as strings; coerce, then reuse the shared cents
// conversion so matching and ledger writes use the same rounding rule.
const toCents = (n: number | string): number => dollarsToCents(Number(n));

function daysBetween(a: string, b: string): number {
  return Math.abs(new Date(a).getTime() - new Date(b).getTime()) / (24 * 60 * 60 * 1000);
}

function shiftDays(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Bounds for orders supplied in the request body by the desktop app. The
// scraper itself never exceeds 300 orders (30 pages × 10) or 8 items/order,
// so these caps only bite on hand-crafted payloads.
const MAX_BODY_ORDERS = 500;
const MAX_ITEMS_PER_ORDER = 20;
const MAX_ITEM_CHARS = 300;
const MAX_ORDER_ID_CHARS = 64;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isRealDate(value: string): boolean {
  if (!ISO_DATE_RE.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

function parseRows(raw: unknown): PreviewRow[] | null {
  if (!Array.isArray(raw) || raw.length > 1_000) return null;
  const rows: PreviewRow[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) return null;
    const row = entry as Record<string, unknown>;
    if (typeof row.date !== "string" || !isRealDate(row.date)) return null;
    if (typeof row.amount !== "string" || !/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(row.amount.trim())) return null;
    const amount = Number(row.amount);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1e12) return null;
    if (typeof row.description !== "string" || row.description.length > 10_000) return null;
    if (row.type !== "debit" && row.type !== "credit") return null;
    if (row._id !== undefined && (typeof row._id !== "string" || row._id.length > 64)) return null;
    rows.push({
      date: row.date,
      amount: String(amount),
      description: row.description,
      type: row.type,
      ...(typeof row._id === "string" ? { _id: row._id } : {}),
    });
  }
  return rows;
}

// Validates and sanitizes orders supplied by the desktop bridge. They remain
// untrusted HTTP input at this boundary. Returns null when the shape is wrong;
// strings are clamped rather than rejected so a verbose title can't fail a run.
function parseBodyOrders(raw: unknown): AmazonOrder[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_BODY_ORDERS) return null;
  const out: AmazonOrder[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) return null;
    const { amazon_order_id, order_date, amount_usd, items } = entry as Record<string, unknown>;
    if (typeof order_date !== "string" || !isRealDate(order_date)) return null;
    if (typeof amount_usd !== "number" || !Number.isFinite(amount_usd) || amount_usd <= 0 || amount_usd > 1e12) return null;
    if (!Array.isArray(items) || items.some(i => typeof i !== "string")) return null;
    if (amazon_order_id != null && typeof amazon_order_id !== "string") return null;
    out.push({
      amazon_order_id: typeof amazon_order_id === "string" ? amazon_order_id.slice(0, MAX_ORDER_ID_CHARS) : null,
      order_date,
      amount_usd,
      items: (items as string[]).slice(0, MAX_ITEMS_PER_ORDER).map(i => i.slice(0, MAX_ITEM_CHARS)),
    });
  }
  return out;
}

// Max length of the leading item title kept in the saved summary. Amazon titles
// run 100–200 chars, so the title is truncated; the full item list stays
// available for the in-process expander and is never persisted.
const MAX_SUMMARY_TITLE = 40;

function truncateTitle(s: string): string {
  return s.length > MAX_SUMMARY_TITLE ? s.slice(0, MAX_SUMMARY_TITLE).trimEnd() + "…" : s;
}

// "Echo Dot" → "Echo Dot"; ["Echo Dot","Cable","AA"] → "Echo Dot (+2 more)";
// a long first title is truncated, e.g. "Seventh Generation Concentrated Free & C… (+1 more)".
// Operates on the structured item list so a comma inside one title never
// inflates the count.
export function summarizeItems(items: string[]): string {
  if (items.length === 0) return "";
  const [first, ...rest] = items;
  const head = truncateTitle(first);
  return rest.length ? `${head} (+${rest.length} more)` : head;
}

export function createImportsRouter(db: DrizzleDB, scrape: ScrapeFn | null, readSettings: () => LocalSettings) {
  const router = Router();

  // POST /api/imports/amazon-match
  // Body: { rows: PreviewRow[], orders?: AmazonOrder[] }
  // `orders` is the desktop-app path: the Balance Desktop shell scrapes the
  // user's own Amazon order history locally and submits the result here, so
  // the server never touches an Amazon session. Tests can inject a synthetic
  // scrape function; production requires the desktop-supplied `orders` body.
  // Returns: { matches, matched_count, unmatched_amazon_count, scrape_window, scraped_orders, default_account_id }
  router.post("/amazon-match", async (req, res) => {
    try {
      const { rows: rawRows, orders: rawOrders } = req.body as { rows?: unknown; orders?: unknown };
      const rows = parseRows(rawRows);
      if (!rows) return res.status(400).json({ error: "rows must contain at most 1,000 valid transaction previews" });

      let bodyOrders: AmazonOrder[] | null = null;
      if (rawOrders !== undefined) {
        bodyOrders = parseBodyOrders(rawOrders);
        if (!bodyOrders) {
          return res.status(400).json({
            error: "orders must be an array (max 500) of { amazon_order_id, order_date: YYYY-MM-DD, amount_usd: number, items: string[] }",
          });
        }
      }

      const candidateIdxs: number[] = [];
      rows.forEach((r, i) => { if (AMAZON_RE.test(r.description ?? "")) candidateIdxs.push(i); });

      // Always wipe this household's temp rows -- even if no candidates -- to keep
      // the "fresh state per run" contract simple to reason about.
      await db.delete(amazonOrders);

      const { amazonDefaultAccountId } = readSettings();

      if (candidateIdxs.length === 0) {
        return res.json({
          matches: [] as Match[],
          matched_count: 0,
          unmatched_amazon_count: 0,
          scrape_window: null,
          scraped_orders: 0,
          default_account_id: amazonDefaultAccountId,
        });
      }

      const candidateDates = candidateIdxs.map(i => rows[i].date).sort();
      const fromIso = candidateDates[candidateDates.length - 1];
      const toIso = shiftDays(candidateDates[0], -SCRAPE_BACKDATE_DAYS);
      const fromDate = new Date(fromIso + "T00:00:00Z");
      const toDate = new Date(toIso + "T00:00:00Z");

      if (bodyOrders === null && scrape === null) {
        return res.status(400).json({
          error: "Amazon orders must be supplied by the Balance Desktop app.",
        });
      }
      const scraped = bodyOrders ?? await scrape!(fromDate, toDate);

      // Match: deterministic greedy by (date asc, amount asc, original-index asc).
      type Avail = AmazonOrder & { used: boolean };
      const pool: Avail[] = scraped
        .slice()
        .sort((a, b) => a.order_date.localeCompare(b.order_date) || a.amount_usd - b.amount_usd)
        .map(o => ({ ...o, used: false }));

      const candidatesSorted = candidateIdxs
        .map(i => ({ i, row: rows[i] }))
        .sort((a, b) =>
          a.row.date.localeCompare(b.row.date) ||
          toCents(a.row.amount) - toCents(b.row.amount) ||
          a.i - b.i
        );

      const matches: Match[] = [];
      for (const { i, row } of candidatesSorted) {
        const cents = toCents(row.amount);
        const hit = pool.find(o =>
          !o.used &&
          toCents(o.amount_usd) === cents &&
          daysBetween(o.order_date, row.date) <= MATCH_WINDOW_DAYS
        );
        if (hit) {
          hit.used = true;
          matches.push({ _id: row._id ?? null, index: i, summary: summarizeItems(hit.items), items: hit.items });
        }
      }
      matches.sort((a, b) => a.index - b.index);

      const matchedCount = matches.length;
      const unmatchedCandidates = candidateIdxs.length - matchedCount;

      res.json({
        matches,
        matched_count: matchedCount,
        unmatched_amazon_count: unmatchedCandidates,
        scrape_window: { from: fromIso, to: toIso },
        scraped_orders: scraped.length,
        default_account_id: amazonDefaultAccountId,
      });
    } catch (err) {
      console.error("[amazon-match]", err);
      res.status(500).json({ error: "Failed to match Amazon orders" });
    }
  });

  return router;
}
