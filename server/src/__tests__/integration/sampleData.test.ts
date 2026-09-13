import { describe, it, expect } from "vitest";
import request from "supertest";
import { createApp } from "../../app.js";
import { createTestDb } from "../../test/db.js";
import { SAMPLE_ACCOUNT_DEFS } from "../../lib/sampleData.js";

async function makeApp() {
  const db = await createTestDb();
  return { app: createApp(db), db };
}

const A = "household-A";
const B = "household-B";

const as = (app: ReturnType<typeof createApp>, hid: string) => ({
  get: (url: string) => request(app).get(url).set("x-household-id", hid),
  post: (url: string) => request(app).post(url).set("x-household-id", hid),
});

interface ApiTx { id: number; account_id: number; amount_fx: number; type: string; date: string }

describe("POST /api/data/sample", () => {
  it("seeds a demo dataset whose counts match the read APIs", async () => {
    const { app } = await makeApp();
    const res = await as(app, A).post("/api/data/sample").send({});
    expect(res.status).toBe(201);
    expect(res.body.accounts).toBe(SAMPLE_ACCOUNT_DEFS.length);
    expect(res.body.transactions).toBeGreaterThan(50);

    const accounts = (await as(app, A).get("/api/accounts")).body as { id: number; name: string; market_value: number | null }[];
    expect(accounts).toHaveLength(res.body.accounts);
    // The RSU sample account carries a computed market value.
    const rsu = accounts.find((a) => a.name === "TechCo RSUs")!;
    expect(rsu.market_value).toBeGreaterThan(0);

    const txs = (await as(app, A).get("/api/transactions")).body as { rows: ApiTx[]; total: number };
    expect(txs.total).toBe(res.body.transactions);

    const cats = (await as(app, A).get("/api/categories")).body as unknown[];
    expect(cats).toHaveLength(res.body.categories);
  });

  it("only generates dates within the last ~3 months, never in the future", async () => {
    const { app } = await makeApp();
    await as(app, A).post("/api/data/sample").send({});
    const { rows } = (await as(app, A).get("/api/transactions")).body as { rows: ApiTx[] };
    const today = new Date().toISOString().slice(0, 10);
    const oldest = new Date(Date.now() - 92 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    for (const r of rows) {
      expect(r.date <= today).toBe(true);
      expect(r.date >= oldest).toBe(true);
    }
  });

  it("stored balances equal opening balance + the ledger's folded deltas", async () => {
    const { app } = await makeApp();
    await as(app, A).post("/api/data/sample").send({});
    const { rows } = (await as(app, A).get("/api/transactions")).body as { rows: ApiTx[] };

    const delta = new Map<number, number>();
    const add = (acc: number, amt: number) => delta.set(acc, (delta.get(acc) ?? 0) + amt);
    for (const r of rows) {
      if (r.type === "debit") add(r.account_id, -r.amount_fx);
      if (r.type === "credit") add(r.account_id, r.amount_fx);
    }
    // Transfer legs are seeded consecutively, from-leg first (lower id).
    const legs = rows.filter((r) => r.type === "transfer").sort((a, b) => a.id - b.id);
    expect(legs.length % 2).toBe(0);
    for (let i = 0; i < legs.length; i += 2) {
      add(legs[i].account_id, -legs[i].amount_fx);
      add(legs[i + 1].account_id, +legs[i + 1].amount_fx);
    }

    const accounts = (await as(app, A).get("/api/accounts")).body as { id: number; name: string; balance: number }[];
    for (const def of SAMPLE_ACCOUNT_DEFS) {
      const acc = accounts.find((a) => a.name === def.name)!;
      expect(acc.balance).toBeCloseTo(def.opening / 100 + (delta.get(acc.id) ?? 0), 2);
    }
  });

  it("starts with zero canonical drift and stays stable after the next mutation", async () => {
    const { app } = await makeApp();
    await as(app, A).post("/api/data/sample").send({});
    const accounts = (await as(app, A).get("/api/accounts")).body as { id: number; name: string; balance: number }[];

    for (const account of accounts) {
      const verification = await as(app, A).get(`/api/accounts/${account.id}/verify`);
      expect(verification.status).toBe(200);
      expect(verification.body.drift).toBe(0);
    }

    const checking = accounts.find((account) => account.name === "Everyday Checking")!;
    const before = checking.balance;
    const created = await as(app, A).post("/api/transactions").send({
      account_id: checking.id,
      category_id: null,
      date: new Date().toISOString().slice(0, 10),
      description: "Synthetic correction",
      amount_fx: 1,
      exchange_rate: 1,
      type: "credit",
    });
    expect(created.status).toBe(201);
    const refreshed = (await as(app, A).get("/api/accounts")).body as { id: number; balance: number }[];
    expect(refreshed.find((account) => account.id === checking.id)!.balance).toBe(before + 1);
  });

  it("refuses to seed a household that already has accounts", async () => {
    const { app } = await makeApp();
    await as(app, A).post("/api/accounts").send({
      name: "Real Checking", account_type: "Checking", liquidity_type: "Liquid",
      base_currency: "USD", balance: 0, exchange_rate: 1, balance_usd: 0,
    });
    const res = await as(app, A).post("/api/data/sample").send({});
    expect(res.status).toBe(400);
    expect((await as(app, A).get("/api/accounts")).body).toHaveLength(1);
  });

});
