import { describe, it, expect } from "vitest";
import request from "supertest";
import { createApp } from "../../app.js";
import { createTestDb } from "../../test/db.js";
import { transactions } from "../../db/schema.js";

async function makeApp() {
  const db = await createTestDb();
  return { app: createApp(db), db };
}

async function createAccount(app: ReturnType<typeof createApp>, name: string) {
  const res = await request(app).post("/api/accounts").send({
    name, account_type: "Checking", liquidity_type: "Liquid",
    base_currency: "USD", balance: 0, exchange_rate: 1, balance_usd: 0,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  expect(res.body.id).toEqual(expect.any(Number));
  return res.body as { id: number };
}

describe("transfer_group_id", () => {
  it("POST /transfer stamps both legs with the same group id", async () => {
    const { app } = await makeApp();
    const from = await createAccount(app, "Checking");
    const to = await createAccount(app, "Savings");

    const res = await request(app).post("/api/transactions/transfer").send({
      from_account_id: from.id, to_account_id: to.id,
      date: "2025-06-01", description: "Savings", amount_fx: 100,
    });
    expect(res.status).toBe(201);
    const [a, b] = res.body as { transfer_group_id: string | null }[];
    expect(a.transfer_group_id).toBeTruthy();
    expect(a.transfer_group_id).toBe(b.transfer_group_id);
  });

  it("pairs ambiguous same-day same-amount transfers exactly, not by heuristic", async () => {
    const { app } = await makeApp();
    const checking = await createAccount(app, "Checking");
    const savings = await createAccount(app, "Savings");
    const broker = await createAccount(app, "Broker");

    // Two $100 transfers on the same date out of the same account -- the exact
    // shape the date+amount heuristic could mis-pair.
    const t = (to: number) => request(app).post("/api/transactions/transfer").send({
      from_account_id: checking.id, to_account_id: to,
      date: "2025-06-01", description: "", amount_fx: 100,
    });
    await t(savings.id);
    await t(broker.id);

    const { rows } = (await request(app).get("/api/transactions")).body as {
      rows: { account_name: string; transfer_group_id: string | null; transfer_from: string | null; transfer_to: string | null }[];
    };
    expect(rows).toHaveLength(4);
    const groups = new Set(rows.map((r) => r.transfer_group_id));
    expect(groups.size).toBe(2);
    // Every leg resolves its own pair's endpoints, never the other transfer's.
    for (const r of rows) {
      expect(r.transfer_from).toBe("Checking");
      const expectedTo = rows.find((o) => o.transfer_group_id === r.transfer_group_id && o.account_name !== "Checking")!;
      expect(r.transfer_to).toBe(expectedTo.account_name);
    }
  });

  it("legacy transfers without a group id still pair by the date+amount fallback", async () => {
    const { app, db } = await makeApp();
    const from = await createAccount(app, "Old From");
    const to = await createAccount(app, "Old To");

    // Simulate pre-migration rows: no transfer_group_id.
    db.insert(transactions).values([
      { account_id: from.id, date: "2025-05-01", description: "", amount_fx: 5000, exchange_rate: 1, amount_usd: 5000, type: "transfer" },
      { account_id: to.id, date: "2025-05-01", description: "", amount_fx: 5000, exchange_rate: 1, amount_usd: 5000, type: "transfer" },
    ]).run();

    const response = await request(app).get("/api/transactions");
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.rows).toBeInstanceOf(Array);
    const { rows } = response.body as {
      rows: { transfer_from: string | null; transfer_to: string | null }[];
    };
    for (const r of rows) {
      expect(r.transfer_from).toBe("Old From");
      expect(r.transfer_to).toBe("Old To");
    }
  });
});
