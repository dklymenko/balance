import { describe, it, expect } from "vitest";
import request from "supertest";
import { createApp } from "../../app.js";
import { createTestDb } from "../../test/db.js";
import { detectSubscriptions } from "../../routes/insights.js";

async function makeApp() {
  const db = await createTestDb();
  return { app: createApp(db), db };
}

const A = "household-A";
const B = "household-B";

const as = (app: ReturnType<typeof createApp>, hid: string) => ({
  get: (url: string) => request(app).get(url).set("x-household-id", hid),
  post: (url: string) => request(app).post(url).set("x-household-id", hid),
  patch: (url: string) => request(app).patch(url).set("x-household-id", hid),
});

const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

async function seedLedger(app: ReturnType<typeof createApp>, hid: string) {
  const acc = (await as(app, hid).post("/api/accounts").send({
    name: "Card", account_type: "CC", liquidity_type: "Liquid",
    base_currency: "USD", balance: 0, exchange_rate: 1, balance_usd: 0,
  })).body as { id: number };

  const row = (description: string, amount_fx: number, date: string, type = "debit") =>
    ({ account_id: acc.id, category_id: null, date, description, amount_fx, exchange_rate: 1, type, tag_ids: [] });

  const rows = [
    // Monthly, stable amount, 4 charges → a subscription.
    ...[90, 60, 30, 1].map((d, i) => row(`Streamly #${i}`, 15.99, daysAgo(d))),
    // Weekly groceries with varying amounts → not a subscription (gaps too short).
    ...[28, 21, 14, 7].map((d, i) => row("FreshMart", 80 + i * 15, daysAgo(d))),
    // Two charges only → not enough history.
    row("MusicNow", 10.99, daysAgo(40)),
    row("MusicNow", 10.99, daysAgo(10)),
    // One-off purchase.
    row("Nordic Home Store", 129.99, daysAgo(12)),
  ];
  const res = await as(app, hid).post("/api/transactions/bulk").send({ rows });
  expect(res.status).toBe(201);
}

describe("GET /api/insights/subscriptions", () => {
  it("detects monthly stable-amount merchants and reports the monthly total", async () => {
    const { app } = await makeApp();
    await seedLedger(app, A);

    const res = await as(app, A).get("/api/insights/subscriptions");
    expect(res.status).toBe(200);
    expect(res.body.subscriptions).toHaveLength(1);
    const sub = res.body.subscriptions[0];
    expect(sub.merchant).toBe("streamly");
    expect(sub.monthly_usd).toBeCloseTo(15.99);
    expect(sub.charges).toBe(4);
    expect(sub.last_charge).toBe(daysAgo(1));
    expect(res.body.total_monthly_usd).toBeCloseTo(15.99);
  });

  it("omits subscriptions charged to an account excluded from reports", async () => {
    const { app } = await makeApp();
    const account = (await as(app, A).post("/api/accounts").send({
      name: "Private card", account_type: "CC", liquidity_type: "Liquid",
      base_currency: "USD", balance: 0, exchange_rate: 1, balance_usd: 0,
    })).body as { id: number };
    await as(app, A).patch(`/api/accounts/${account.id}`).send({ exclude_from_reports: true });
    await as(app, A).post("/api/transactions/bulk").send({ rows: [90, 60, 30].map((days) => ({
      account_id: account.id, category_id: null, date: daysAgo(days),
      description: "Hidden Service", amount_fx: 25, exchange_rate: 1, type: "debit", tag_ids: [],
    })) });

    const res = await as(app, A).get("/api/insights/subscriptions");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ subscriptions: [], total_monthly_usd: 0 });
  });

});

describe("detectSubscriptions", () => {
  const charge = (date: string, amount_usd: number, description = "Streamly") =>
    ({ date, description, amount_usd, category_name: null });

  it("rejects merchants whose amounts drift beyond the tolerance", () => {
    const subs = detectSubscriptions([
      charge("2025-01-05", 1599), charge("2025-02-04", 2599), charge("2025-03-06", 3599),
    ]);
    expect(subs).toEqual([]);
  });

  it("accepts small price jitter within $1", () => {
    const subs = detectSubscriptions([
      charge("2025-01-05", 1599), charge("2025-02-04", 1649), charge("2025-03-06", 1599),
    ]);
    expect(subs).toHaveLength(1);
    expect(subs[0].monthly_usd).toBeCloseTo(15.99);
  });

  it("rejects irregular cadence (a skipped month breaks the chain)", () => {
    const subs = detectSubscriptions([
      charge("2025-01-05", 1599), charge("2025-02-04", 1599), charge("2025-04-05", 1599),
    ]);
    expect(subs).toEqual([]);
  });
});
