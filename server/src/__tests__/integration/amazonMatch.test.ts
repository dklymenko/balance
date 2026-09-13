import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { createApp } from "../../app.js";
import { createTestDb } from "../../test/db.js";
import { amazonOrders } from "../../db/schema.js";
import type { AmazonOrder, ScrapeFn } from "../../lib/amazonScraper.js";

type Row = {
  date: string;
  amount: string;
  description: string;
  type: "debit" | "credit";
  _id?: string;
};

type Match = { _id: string | null; index: number; summary: string; items: string[] };

function makeRow(overrides: Partial<Row> = {}): Row {
  return {
    date: "2026-04-25",
    amount: "22.22",
    description: "AMAZON MKTPL*BJ33U9R52",
    type: "debit",
    ...overrides,
  };
}

function byIndex(matches: Match[]): Map<number, Match> {
  return new Map(matches.map(m => [m.index, m]));
}

describe("POST /api/imports/amazon-match", () => {
  let scrapeCalls: Array<{ from: string; to: string }>;

  beforeEach(() => {
    scrapeCalls = [];
  });

  function makeAppWith(orders: AmazonOrder[], amazonDefaultAccountId: number | null = null) {
    const db = createTestDb();
    const scrapeFn: ScrapeFn = async (from, to) => {
      scrapeCalls.push({ from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) });
      return orders;
    };
    const app = createApp(db, undefined, scrapeFn, () => ({ amazonDefaultAccountId }));
    return { app, db };
  }

  it("returns 400 when rows missing", async () => {
    const { app } = makeAppWith([]);
    const res = await request(app).post("/api/imports/amazon-match").send({});
    expect(res.status).toBe(400);
  });

  it("requires orders from the desktop bridge when no test scraper is injected", async () => {
    const app = createApp(await createTestDb());
    const res = await request(app).post("/api/imports/amazon-match").send({ rows: [makeRow()] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/desktop/i);
  });

  it("rejects oversized or malformed preview rows before scraping", async () => {
    const { app } = makeAppWith([]);
    for (const rows of [
      [makeRow({ date: "2026-02-31" })],
      [makeRow({ amount: "10oops" })],
      [makeRow({ amount: "0" })],
      Array.from({ length: 1001 }, () => makeRow()),
    ]) {
      expect((await request(app).post("/api/imports/amazon-match").send({ rows })).status).toBe(400);
    }
    expect(scrapeCalls).toHaveLength(0);
  });

  it("only treats rows whose description matches /amazon|amzn/i as candidates", async () => {
    const { app } = makeAppWith([
      { amazon_order_id: "111", order_date: "2026-04-25", amount_usd: 22.22, items: ["Echo Dot"] },
    ]);
    const rows = [
      makeRow({ description: "AMAZON MKTPL*ABC", amount: "22.22", date: "2026-04-25" }),
      makeRow({ description: "WHOLEFDS PAL 10005", amount: "22.22", date: "2026-04-25" }),
      makeRow({ description: "amzn mktp us*xyz", amount: "22.22", date: "2026-04-25" }),
    ];
    const res = await request(app).post("/api/imports/amazon-match").send({ rows });
    expect(res.status).toBe(200);
    // Only one Amazon order to consume → exactly one of the two Amazon rows matches.
    expect(res.body.matches).toHaveLength(1);
    const m = byIndex(res.body.matches);
    expect(m.get(0)!.summary).toBe("Echo Dot");
    expect(m.get(0)!.items).toEqual(["Echo Dot"]);
    // The non-Amazon row (index 1) is never a candidate.
    expect(m.has(1)).toBe(false);
    expect(res.body.matched_count).toBe(1);
    expect(res.body.unmatched_amazon_count).toBe(1);
  });

  it("computes scrape window: from = max(tx.date), to = min(tx.date) - 90d", async () => {
    const { app } = makeAppWith([]);
    const rows = [
      makeRow({ date: "2026-04-10" }),
      makeRow({ date: "2026-04-25" }),
      makeRow({ date: "2026-04-15" }),
    ];
    await request(app).post("/api/imports/amazon-match").send({ rows });
    expect(scrapeCalls).toHaveLength(1);
    expect(scrapeCalls[0].from).toBe("2026-04-25");
    expect(scrapeCalls[0].to).toBe("2026-01-10"); // 04-10 minus 90 days
  });

  it("matches by amount and returns items array + compact summary", async () => {
    const { app } = makeAppWith([
      { amazon_order_id: "111", order_date: "2026-04-23", amount_usd: 33.33, items: ["USB-C Cable"] },
      { amazon_order_id: "222", order_date: "2026-04-24", amount_usd: 11.11, items: ["Echo Dot", "AA batteries"] },
    ]);
    const rows = [
      makeRow({ amount: "33.33", date: "2026-04-23", description: "AMAZON MKTPL*BJ6QI8EO2", _id: "a" }),
      makeRow({ amount: "11.11", date: "2026-04-24", description: "AMAZON MKTPL*BY5MT2610", _id: "b" }),
    ];
    const res = await request(app).post("/api/imports/amazon-match").send({ rows });
    const m = byIndex(res.body.matches);
    expect(m.get(0)!.summary).toBe("USB-C Cable");
    expect(m.get(0)!.items).toEqual(["USB-C Cable"]);
    expect(m.get(0)!._id).toBe("a");
    expect(m.get(1)!.summary).toBe("Echo Dot (+1 more)");
    expect(m.get(1)!.items).toEqual(["Echo Dot", "AA batteries"]);
    expect(res.body.matched_count).toBe(2);
  });

  it("a single item title containing a comma is not miscounted as multiple items", async () => {
    const { app } = makeAppWith([
      { amazon_order_id: "111", order_date: "2026-04-23", amount_usd: 33.33, items: ["Echo Dot (5th Gen), Charcoal"] },
    ]);
    const rows = [makeRow({ amount: "33.33", date: "2026-04-23", description: "AMAZON MKTPL*XYZ" })];
    const res = await request(app).post("/api/imports/amazon-match").send({ rows });
    const m = byIndex(res.body.matches);
    expect(m.get(0)!.summary).toBe("Echo Dot (5th Gen), Charcoal"); // no "(+N more)"
    expect(m.get(0)!.items).toEqual(["Echo Dot (5th Gen), Charcoal"]);
  });

  it("truncates a long single-item title in the saved summary but keeps the full item for the expander", async () => {
    const longTitle = "Seventh Generation Concentrated Free & Clear Laundry Detergent 99 Loads";
    const { app } = makeAppWith([
      { amazon_order_id: "111", order_date: "2026-04-23", amount_usd: 19.99, items: [longTitle] },
    ]);
    const rows = [makeRow({ amount: "19.99", date: "2026-04-23", description: "AMAZON MKTPL*XYZ" })];
    const res = await request(app).post("/api/imports/amazon-match").send({ rows });
    const m = res.body.matches[0];
    expect(m.summary.length).toBeLessThanOrEqual(41); // 40-char cap + ellipsis
    expect(m.summary.endsWith("…")).toBe(true);
    expect(m.items).toEqual([longTitle]); // full title still available for display
  });

  it("does not match when amounts differ", async () => {
    const { app } = makeAppWith([
      { amazon_order_id: "111", order_date: "2026-04-23", amount_usd: 33.33, items: ["USB-C Cable"] },
    ]);
    const rows = [
      makeRow({ amount: "37.31", date: "2026-04-23", description: "AMAZON.COM*XYZ" }),
    ];
    const res = await request(app).post("/api/imports/amazon-match").send({ rows });
    expect(res.body.matches).toEqual([]);
    expect(res.body.matched_count).toBe(0);
    expect(res.body.unmatched_amazon_count).toBe(1);
  });

  it("does not match outside ±60 day window", async () => {
    const { app } = makeAppWith([
      { amazon_order_id: "111", order_date: "2026-01-15", amount_usd: 33.33, items: ["USB-C Cable"] },
    ]);
    const rows = [
      makeRow({ amount: "33.33", date: "2026-04-20", description: "AMAZON.COM*XYZ" }),
    ];
    const res = await request(app).post("/api/imports/amazon-match").send({ rows });
    expect(res.body.matched_count).toBe(0);
  });

  it("treats duplicate amounts as fungible (one-to-one consumption, monthly total preserved)", async () => {
    const { app } = makeAppWith([
      { amazon_order_id: "111", order_date: "2026-04-23", amount_usd: 25.00, items: ["Item A"] },
      { amazon_order_id: "222", order_date: "2026-04-24", amount_usd: 25.00, items: ["Item B"] },
    ]);
    const rows = [
      makeRow({ amount: "25.00", date: "2026-04-23", description: "AMAZON MKTPL*XYZ" }),
      makeRow({ amount: "25.00", date: "2026-04-24", description: "AMAZON MKTPL*ABC" }),
    ];
    const res = await request(app).post("/api/imports/amazon-match").send({ rows });
    expect(res.body.matched_count).toBe(2);
    const summaries = res.body.matches.map((m: Match) => m.summary).sort();
    expect(summaries).toEqual(["Item A", "Item B"]);
  });

  it("is idempotent: running twice produces identical result", async () => {
    const orders: AmazonOrder[] = [
      { amazon_order_id: "111", order_date: "2026-04-23", amount_usd: 33.33, items: ["USB-C Cable"] },
      { amazon_order_id: "222", order_date: "2026-04-24", amount_usd: 11.11, items: ["Echo Dot"] },
    ];
    const { app } = makeAppWith(orders);
    const rows = [
      makeRow({ amount: "33.33", date: "2026-04-23", description: "AMAZON MKTPL*BJ6QI8EO2", _id: "a" }),
      makeRow({ amount: "11.11", date: "2026-04-24", description: "AMAZON MKTPL*BY5MT2610", _id: "b" }),
    ];
    const first = await request(app).post("/api/imports/amazon-match").send({ rows });
    const second = await request(app).post("/api/imports/amazon-match").send({ rows });
    expect(second.body).toEqual(first.body);
  });

  it("clears the legacy order cache without persisting newly matched items", async () => {
    const { app, db } = makeAppWith([
      { amazon_order_id: "111", order_date: "2026-04-23", amount_usd: 33.33, items: ["USB-C Cable"] },
    ]);
    await db.insert(amazonOrders).values({ amazon_order_id: "stale", order_date: "2020-01-01", amount_usd: 999, items: "stale" });
    await request(app).post("/api/imports/amazon-match").send({ rows: [makeRow({ amount: "33.33", date: "2026-04-23" })] });
    expect(await db.select().from(amazonOrders)).toHaveLength(0);
  });

  it("skips scrape entirely when no Amazon candidates exist", async () => {
    const { app } = makeAppWith([]);
    const rows = [
      makeRow({ description: "WHOLEFDS PAL 10005" }),
      makeRow({ description: "STARBUCKS #1234" }),
    ];
    const res = await request(app).post("/api/imports/amazon-match").send({ rows });
    expect(res.status).toBe(200);
    expect(scrapeCalls).toHaveLength(0);
    expect(res.body.matched_count).toBe(0);
    expect(res.body.unmatched_amazon_count).toBe(0);
    expect(res.body.matches).toEqual([]);
  });

  it("returns amazonDefaultAccountId from local settings as default_account_id", async () => {
    const { app } = makeAppWith([
      { amazon_order_id: "111", order_date: "2026-04-23", amount_usd: 10.00, items: ["Item A"] },
    ], 42);
    const rows = [makeRow({ description: "AMAZON MKTPL*XYZ", amount: "10.00", date: "2026-04-23" })];
    const res = await request(app).post("/api/imports/amazon-match").send({ rows });
    expect(res.body.default_account_id).toBe(42);
  });

  it("returns null default_account_id when no candidates and no setting", async () => {
    const { app } = makeAppWith([]);
    const rows = [makeRow({ description: "STARBUCKS" })];
    const res = await request(app).post("/api/imports/amazon-match").send({ rows });
    expect(res.body.default_account_id).toBeNull();
  });

  describe("client-supplied orders (desktop bridge)", () => {
    it("uses orders from the request body and never calls the scrape function", async () => {
      // Scraper stub returns a decoy; if the route consulted it, the decoy would match.
      const { app, db } = makeAppWith([
        { amazon_order_id: "decoy", order_date: "2026-04-25", amount_usd: 22.22, items: ["Decoy Item"] },
      ]);
      const orders: AmazonOrder[] = [
        { amazon_order_id: "111", order_date: "2026-04-24", amount_usd: 22.22, items: ["Echo Dot"] },
      ];
      const rows = [makeRow({ amount: "22.22", date: "2026-04-25", _id: "a" })];
      const res = await request(app).post("/api/imports/amazon-match").send({ rows, orders });
      expect(res.status).toBe(200);
      expect(scrapeCalls).toHaveLength(0);
      expect(res.body.matched_count).toBe(1);
      expect(res.body.matches[0].summary).toBe("Echo Dot");
      expect(res.body.scraped_orders).toBe(1);
      // Full order contents are used in memory only and must not persist after
      // matching; the legacy cache is cleared at the start of every run.
      const stored = await db.select().from(amazonOrders);
      expect(stored).toHaveLength(0);
    });

    it("returns 400 when orders is not an array of well-formed entries", async () => {
      const { app } = makeAppWith([]);
      const rows = [makeRow()];
      for (const orders of [
        "nope",
        [{ order_date: "not-a-date", amount_usd: 1, items: [] }],
        [{ order_date: "2026-02-31", amount_usd: 1, items: [] }],
        [{ order_date: "2026-04-24", amount_usd: 0, items: [] }],
        [{ order_date: "2026-04-24", amount_usd: "22.22", items: [] }],
        [{ order_date: "2026-04-24", amount_usd: 22.22, items: [42] }],
      ]) {
        const res = await request(app).post("/api/imports/amazon-match").send({ rows, orders });
        expect(res.status).toBe(400);
      }
      expect(scrapeCalls).toHaveLength(0);
    });

    it("returns 400 when more than 500 orders are supplied", async () => {
      const { app } = makeAppWith([]);
      const orders = Array.from({ length: 501 }, (_, i) => ({
        amazon_order_id: String(i), order_date: "2026-04-24", amount_usd: 1, items: [],
      }));
      const res = await request(app).post("/api/imports/amazon-match").send({ rows: [makeRow()], orders });
      expect(res.status).toBe(400);
    });

    it("caps items per order at 20 and item titles at 300 chars", async () => {
      const { app } = makeAppWith([]);
      const orders = [{
        amazon_order_id: "111",
        order_date: "2026-04-24",
        amount_usd: 22.22,
        items: Array.from({ length: 25 }, () => "x".repeat(400)),
      }];
      const rows = [makeRow({ amount: "22.22", date: "2026-04-25" })];
      const res = await request(app).post("/api/imports/amazon-match").send({ rows, orders });
      expect(res.status).toBe(200);
      expect(res.body.matches).toHaveLength(1);
      expect(res.body.matches[0].items).toHaveLength(20);
      expect(res.body.matches[0].items[0]).toHaveLength(300);
    });
  });

  it("reports the matched candidate by its original row index", async () => {
    const { app } = makeAppWith([
      { amazon_order_id: "111", order_date: "2026-04-23", amount_usd: 10.00, items: ["Item A"] },
    ]);
    const rows = [
      makeRow({ description: "WHOLEFDS PAL", amount: "44.44", date: "2026-04-28" }),
      makeRow({ description: "AMAZON MKTPL*XYZ", amount: "10.00", date: "2026-04-23" }),
      makeRow({ description: "STARBUCKS", amount: "5.00", date: "2026-04-22" }),
    ];
    const res = await request(app).post("/api/imports/amazon-match").send({ rows });
    expect(res.body.matches).toHaveLength(1);
    expect(res.body.matches[0].index).toBe(1);
    expect(res.body.matches[0].summary).toBe("Item A");
  });
});
