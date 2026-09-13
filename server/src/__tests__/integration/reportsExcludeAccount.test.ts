import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { createApp } from "../../app.js";
import { createTestDb } from "../../test/db.js";

async function makeApp() {
  const db = await createTestDb();
  return { app: createApp(db), db };
}

const account = (name: string) => ({
  name, account_type: "Checking", liquidity_type: "Liquid",
  base_currency: "USD", balance: 0, exchange_rate: 1, balance_usd: 0,
  ticker: null, shares_quantity: null, current_price_usd: null, notes: null,
});

const tx = (account_id: number, over: Record<string, unknown>) =>
  ({ account_id, date: "2025-03-10", description: "", amount_fx: 0, exchange_rate: 1, amount_usd: 0, type: "debit", ...over });

// Account-level exclude_from_reports: a whole account's transactions are left
// out of every report, while still living in the ledger and net worth.
describe("reports exclude account from reports", () => {
  let app: Awaited<ReturnType<typeof makeApp>>["app"];
  let countedId: number;
  let excludedId: number;

  beforeEach(async () => {
    ({ app } = await makeApp());
    countedId = (await request(app).post("/api/accounts").send(account("Counted"))).body.id;
    excludedId = (await request(app).post("/api/accounts").send(account("Excluded"))).body.id;
    await request(app).patch(`/api/accounts/${excludedId}`).send({ exclude_from_reports: true });

    await request(app).post("/api/transactions").send(tx(countedId, { amount_fx: 100, amount_usd: 100, type: "debit" }));
    await request(app).post("/api/transactions").send(tx(excludedId, { amount_fx: 500, amount_usd: 500, type: "debit" }));
    await request(app).post("/api/transactions").send(tx(countedId, { amount_fx: 200, amount_usd: 200, type: "credit" }));
    await request(app).post("/api/transactions").send(tx(excludedId, { amount_fx: 900, amount_usd: 900, type: "credit" }));
  });

  it("PATCH persists the flag and GET returns it", async () => {
    const accts = (await request(app).get("/api/accounts")).body as { id: number; exclude_from_reports: boolean }[];
    expect(accts.find(a => a.id === excludedId)!.exclude_from_reports).toBe(true);
    expect(accts.find(a => a.id === countedId)!.exclude_from_reports).toBe(false);
  });

  it("omits the excluded account from spend-by-category", async () => {
    const res = await request(app).get("/api/reports/spend-by-category?start=2025-01&end=2025-12");
    const total = res.body.reduce((s: number, r: { total_usd: number }) => s + r.total_usd, 0);
    expect(total).toBe(100); // the $500 debit on the excluded account is left out
  });

  it("omits the excluded account from spend-over-time and spend-by-day", async () => {
    expect((await request(app).get("/api/reports/spend-over-time?start=2025-01&end=2025-12")).body)
      .toEqual([{ period: "2025-03", total_usd: 100 }]);
    expect((await request(app).get("/api/reports/spend-by-day?start=2025-01-01&end=2025-12-31")).body)
      .toEqual([{ date: "2025-03-10", total_usd: 100 }]);
  });

  it("omits the excluded account from income-spend-savings", async () => {
    const res = await request(app).get("/api/reports/income-spend-savings?start=2025-01&end=2025-12");
    expect(res.body).toEqual([{ period: "2025-03", income: 200, spend: 100, savings: 100 }]);
  });

  it("keeps the excluded account's transactions in the ledger", async () => {
    const list = (await request(app).get("/api/transactions")).body.rows;
    expect(list).toHaveLength(4);
  });

  it("un-excluding the account brings its transactions back into reports", async () => {
    await request(app).patch(`/api/accounts/${excludedId}`).send({ exclude_from_reports: false });
    const res = await request(app).get("/api/reports/spend-by-category?start=2025-01&end=2025-12");
    const total = res.body.reduce((s: number, r: { total_usd: number }) => s + r.total_usd, 0);
    expect(total).toBe(600); // 100 + 500
  });
});
