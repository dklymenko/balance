import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { createApp } from "../../app.js";
import { createTestDb } from "../../test/db.js";

async function makeApp() {
  const db = await createTestDb();
  return { app: createApp(db), db };
}

const ACCOUNT = {
  name: "Checking", account_type: "Checking", liquidity_type: "Liquid",
  base_currency: "USD", balance: 0, exchange_rate: 1, balance_usd: 0,
  ticker: null, shares_quantity: null, current_price_usd: null, notes: null,
};

function tx(account_id: number, over: Record<string, unknown>) {
  return { account_id, date: "2025-03-10", description: "", amount_fx: 0, exchange_rate: 1, amount_usd: 0, type: "debit", ...over };
}

describe("reports exclude_from_reports", () => {
  let app: Awaited<ReturnType<typeof makeApp>>["app"];
  let accId: number;

  beforeEach(async () => {
    ({ app } = await makeApp());
    accId = (await request(app).post("/api/accounts").send(ACCOUNT)).body.id;
    // $100 counted debit, $40 excluded debit, $200 counted income, $25 excluded income.
    await request(app).post("/api/transactions").send(tx(accId, { amount_fx: 100, amount_usd: 100, type: "debit" }));
    await request(app).post("/api/transactions").send(tx(accId, { amount_fx: 40, amount_usd: 40, type: "debit", exclude_from_reports: true }));
    await request(app).post("/api/transactions").send(tx(accId, { amount_fx: 200, amount_usd: 200, type: "credit" }));
    await request(app).post("/api/transactions").send(tx(accId, { amount_fx: 25, amount_usd: 25, type: "credit", exclude_from_reports: true }));
  });

  it("omits excluded debits from spend-by-category", async () => {
    const res = await request(app).get("/api/reports/spend-by-category?start=2025-01&end=2025-12");
    const total = res.body.reduce((s: number, r: { total_usd: number }) => s + r.total_usd, 0);
    expect(total).toBe(100); // not 140
  });

  it("omits excluded debits from spend-over-time", async () => {
    const res = await request(app).get("/api/reports/spend-over-time?start=2025-01&end=2025-12");
    expect(res.body).toEqual([{ period: "2025-03", total_usd: 100 }]);
  });

  it("omits excluded rows from income-spend-savings", async () => {
    const res = await request(app).get("/api/reports/income-spend-savings?start=2025-01&end=2025-12");
    expect(res.body).toEqual([{ period: "2025-03", income: 200, spend: 100, savings: 100 }]);
  });

  it("returns daily debit totals from spend-by-day (excluded/credits omitted)", async () => {
    const res = await request(app).get("/api/reports/spend-by-day?start=2025-01-01&end=2025-12-31");
    expect(res.body).toEqual([{ date: "2025-03-10", total_usd: 100 }]); // only the counted debit
  });

  it("keeps excluded transactions in the ledger and counts them toward the balance", async () => {
    const list = (await request(app).get("/api/transactions")).body.rows;
    expect(list).toHaveLength(4);
    const excluded = list.filter((t: { exclude_from_reports: boolean }) => t.exclude_from_reports);
    expect(excluded).toHaveLength(2);
    // Balance reflects ALL rows: -100 -40 +200 +25 = 85
    const acc = (await request(app).get("/api/accounts")).body.find((a: { id: number }) => a.id === accId);
    expect(acc.balance).toBe(85);
  });

  it("PATCH can flip the flag without changing the balance", async () => {
    const list = (await request(app).get("/api/transactions")).body.rows;
    const counted = list.find((t: { amount_usd: number; exclude_from_reports: boolean }) => t.amount_usd === 100 && !t.exclude_from_reports);
    // Re-send the full row with the flag flipped (same account/amount/type → zero balance delta).
    await request(app).patch(`/api/transactions/${counted.id}`).send({
      account_id: counted.account_id, category_id: counted.category_id, date: counted.date,
      description: counted.description, amount_fx: counted.amount_fx, exchange_rate: counted.exchange_rate,
      amount_usd: counted.amount_usd, type: counted.type, exclude_from_reports: true,
    });
    const acc = (await request(app).get("/api/accounts")).body.find((a: { id: number }) => a.id === accId);
    expect(acc.balance).toBe(85); // unchanged
    const spend = await request(app).get("/api/reports/spend-by-category?start=2025-01&end=2025-12");
    const total = spend.body.reduce((s: number, r: { total_usd: number }) => s + r.total_usd, 0);
    expect(total).toBe(0); // both debits now excluded
  });
});

describe("report query validation", () => {
  it("rejects malformed ranges and filter ids", async () => {
    const { app } = await makeApp();
    expect((await request(app).get("/api/reports/spend-by-category?start=2025-13&end=2025-12")).status).toBe(400);
    expect((await request(app).get("/api/reports/spend-over-time?account_ids=1,nope")).status).toBe(400);
    expect((await request(app).get("/api/reports/spend-by-day?start=2025-02-31&end=2025-03-01")).status).toBe(400);
    expect((await request(app).get("/api/reports/spend-by-day?start=2025-03-02&end=2025-03-01")).status).toBe(400);
    expect((await request(app).get("/api/reports/income-spend-savings?group_by=week")).status).toBe(400);
  });
});
