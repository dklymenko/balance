import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { createApp } from "../../app.js";
import { createTestDb } from "../../test/db.js";
import { accounts, accountAdjustments } from "../../db/schema.js";
import { eq } from "drizzle-orm";

async function makeApp() {
  const db = await createTestDb();
  return { app: createApp(db), db };
}

const BASE_ACCOUNT = {
  name: "Test Checking",
  account_type: "Checking",
  liquidity_type: "Liquid",
  base_currency: "USD",
  balance: 0,
  exchange_rate: 1,
  balance_usd: 0,
  ticker: null,
  shares_quantity: null,
  current_price_usd: null,
  notes: null,
};

describe("GET /api/accounts", () => {
  it("returns empty array on fresh DB", async () => {
    const { app } = await makeApp();
    const res = await request(app).get("/api/accounts");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("returns created accounts", async () => {
    const { app } = await makeApp();
    await request(app).post("/api/accounts").send(BASE_ACCOUNT);
    const res = await request(app).get("/api/accounts");
    expect(res.body).toHaveLength(1);
    expect(res.body[0].name).toBe("Test Checking");
  });

  it("includes has_recent_adjustment as false by default", async () => {
    const { app } = await makeApp();
    await request(app).post("/api/accounts").send(BASE_ACCOUNT);
    const res = await request(app).get("/api/accounts");
    expect(res.body[0].has_recent_adjustment).toBe(false);
  });
});

describe("POST /api/accounts", () => {
  it("creates an account and returns 201", async () => {
    const { app } = await makeApp();
    const res = await request(app).post("/api/accounts").send(BASE_ACCOUNT);
    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.name).toBe("Test Checking");
  });

  it("rejects negative and unrepresentable RSU valuations", async () => {
    const { app } = await makeApp();
    const negative = await request(app).post("/api/accounts").send({
      ...BASE_ACCOUNT, account_type: "RSU", shares_quantity: 1, current_price_usd: -1,
    });
    expect(negative.status).toBe(400);

    const overflow = await request(app).post("/api/accounts").send({
      ...BASE_ACCOUNT, account_type: "RSU", shares_quantity: 1_000_000_000,
      current_price_usd: 1_000_000_000_000,
    });
    expect(overflow.status).toBe(400);
    expect(overflow.body.error).toMatch(/market value|supported money range/);
    expect((await request(app).get("/api/accounts")).body).toHaveLength(0);
  });
});

describe("PATCH /api/accounts/:id", () => {
  it("updates name without requiring reason", async () => {
    const { app } = await makeApp();
    const created = (await request(app).post("/api/accounts").send(BASE_ACCOUNT)).body;
    const res = await request(app).patch(`/api/accounts/${created.id}`).send({ name: "Updated" });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("Updated");
  });

  it("rejects balance change without reason", async () => {
    const { app } = await makeApp();
    const created = (await request(app).post("/api/accounts").send(BASE_ACCOUNT)).body;
    const res = await request(app).patch(`/api/accounts/${created.id}`).send({ balance: 500 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/reason/);
  });

  it("accepts balance change with reason and logs adjustment", async () => {
    const { app, db } = await makeApp();
    const created = (await request(app).post("/api/accounts").send(BASE_ACCOUNT)).body;
    const res = await request(app)
      .patch(`/api/accounts/${created.id}`)
      .send({ balance: 1000, reason: "Opening reconciliation" });
    expect(res.status).toBe(200);
    expect(res.body.balance).toBe(1000);

    const adj = await db.select().from(accountAdjustments).where(eq(accountAdjustments.account_id, created.id));
    expect(adj).toHaveLength(1);
    expect(adj[0].old_balance).toBe(0); // cents
    expect(adj[0].new_balance).toBe(100000); // stored as integer cents
    expect(adj[0].reason).toBe("Opening reconciliation");
  });

  it("serializes concurrent balance reconciliations without adding both targets", async () => {
    const { app } = await makeApp();
    const created = (await request(app).post("/api/accounts").send(BASE_ACCOUNT)).body;
    const [first, second] = await Promise.all([
      request(app).patch(`/api/accounts/${created.id}`).send({ balance: 100, reason: "first" }),
      request(app).patch(`/api/accounts/${created.id}`).send({ balance: 200, reason: "second" }),
    ]);
    expect([first.status, second.status]).toEqual([200, 200]);
    const account = (await request(app).get("/api/accounts")).body[0];
    expect(account.balance).toBe(200);
    const verification = await request(app).get(`/api/accounts/${created.id}/verify`);
    expect(verification.body.drift).toBe(0);
  });

  it("returns has_recent_adjustment=true after balance adjustment (and only there)", async () => {
    const { app } = await makeApp();
    // Two accounts so row ids diverge from adjustment ids -- this used to pass
    // by coincidence when the correlated subquery compared aa.account_id to
    // aa.id (drizzle rendered the outer column unqualified).
    const first = (await request(app).post("/api/accounts").send(BASE_ACCOUNT)).body;
    const second = (await request(app).post("/api/accounts").send({ ...BASE_ACCOUNT, name: "Second" })).body;
    await request(app).patch(`/api/accounts/${second.id}`).send({ balance: 500, reason: "test" });
    const res = await request(app).get("/api/accounts");
    const byId = new Map(res.body.map((a: { id: number; has_recent_adjustment: boolean }) => [a.id, a.has_recent_adjustment]));
    expect(byId.get(second.id)).toBe(true);
    expect(byId.get(first.id)).toBe(false);
  });

  it("returns 404 for unknown account", async () => {
    const { app } = await makeApp();
    const res = await request(app).patch("/api/accounts/9999").send({ name: "x" });
    expect(res.status).toBe(404);
  });

  it("does not require reason when balance is sent unchanged", async () => {
    const { app } = await makeApp();
    const created = (await request(app).post("/api/accounts").send({ ...BASE_ACCOUNT, balance: 250, balance_usd: 250 })).body;
    const res = await request(app)
      .patch(`/api/accounts/${created.id}`)
      .send({ balance: 250, balance_usd: 250, name: "Renamed" });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("Renamed");
  });

  it("updates RSU price and recomputes market_value without requiring reason", async () => {
    const { app } = await makeApp();
    const rsu = (await request(app).post("/api/accounts").send({
      ...BASE_ACCOUNT,
      name: "Equity",
      account_type: "RSU",
      liquidity_type: "Invested",
      balance: 0,
      balance_usd: 0,
      ticker: "ABC",
      shares_quantity: 10,
      current_price_usd: 100,
    })).body;
    expect(rsu.market_value).toBe(1000);

    const res = await request(app).patch(`/api/accounts/${rsu.id}`).send({
      name: "Equity",
      account_type: "RSU",
      liquidity_type: "Invested",
      base_currency: "USD",
      balance: 0,
      exchange_rate: 1,
      balance_usd: 0,
      ticker: "ABC",
      shares_quantity: 10,
      current_price_usd: 150,
      notes: null,
    });
    expect(res.status).toBe(200);
    expect(res.body.current_price_usd).toBe(150);
    expect(res.body.market_value).toBe(1500);
  });

  it("rejects a partial RSU update whose combined valuation overflows", async () => {
    const { app } = await makeApp();
    const rsu = (await request(app).post("/api/accounts").send({
      ...BASE_ACCOUNT, name: "Equity", account_type: "RSU", liquidity_type: "Invested",
      shares_quantity: 1_000_000_000, current_price_usd: 1,
    })).body;
    const res = await request(app).patch(`/api/accounts/${rsu.id}`).send({
      current_price_usd: 1_000_000_000_000,
    });
    expect(res.status).toBe(400);
    expect((await request(app).get("/api/accounts")).body[0].current_price_usd).toBe(1);
  });

  it("updates RSU price even when the stored balance is non-zero (no reason needed)", async () => {
    const { app } = await makeApp();
    // Legacy RSU account carrying a stale non-zero `balance` (market value was
    // once written into balance). The form always submits balance:0 for RSU, so
    // this must not trip the balance-change reason guard.
    const rsu = (await request(app).post("/api/accounts").send({
      ...BASE_ACCOUNT,
      name: "Equity",
      account_type: "RSU",
      liquidity_type: "Invested",
      balance: 5000,
      balance_usd: 5000,
      ticker: "ABC",
      shares_quantity: 10,
      current_price_usd: 200,
    })).body;

    const res = await request(app).patch(`/api/accounts/${rsu.id}`).send({
      name: "Equity",
      account_type: "RSU",
      liquidity_type: "Invested",
      base_currency: "USD",
      balance: 0,
      exchange_rate: 1,
      balance_usd: 0,
      ticker: "ABC",
      shares_quantity: 10,
      current_price_usd: 250,
      notes: null,
    });

    expect(res.status).toBe(200);
    expect(res.body.current_price_usd).toBe(250);
    expect(res.body.market_value).toBe(10 * 250);
    expect(res.body.balance).toBe(0); // stale balance normalized to 0
  });

  it("converts an existing account to RSU without carrying its cash balance into the equity account", async () => {
    const { app } = await makeApp();
    const checking = (await request(app).post("/api/accounts").send({
      ...BASE_ACCOUNT,
      name: "Broker cash",
      balance: 5000,
      balance_usd: 5000,
    })).body;

    const converted = await request(app).patch(`/api/accounts/${checking.id}`).send({
      account_type: "RSU",
      liquidity_type: "Invested",
      balance: 0,
      balance_usd: 0,
      ticker: "ABC",
      shares_quantity: 10,
      current_price_usd: 250,
    });

    expect(converted.status).toBe(200);
    expect(converted.body.balance).toBe(0);
    expect(converted.body.balance_usd).toBe(0);
    expect(converted.body.market_value).toBe(2500);

    const verification = await request(app).get(`/api/accounts/${checking.id}/verify`);
    expect(verification.status).toBe(200);
    expect(verification.body.drift).toBe(0);
    expect(verification.body.stored_balance).toBe(0);
    expect(verification.body.computed_balance).toBe(0);
  });
});

describe("DELETE /api/accounts/:id", () => {
  it("deletes account and returns 204", async () => {
    const { app } = await makeApp();
    const created = (await request(app).post("/api/accounts").send(BASE_ACCOUNT)).body;
    const del = await request(app).delete(`/api/accounts/${created.id}`);
    expect(del.status).toBe(204);
    const list = await request(app).get("/api/accounts");
    expect(list.body).toHaveLength(0);
  });
});

describe("GET /api/accounts/:id/verify", () => {
  it("returns drift=0 for account with no transactions", async () => {
    const { app } = await makeApp();
    const created = (await request(app).post("/api/accounts").send(BASE_ACCOUNT)).body;
    const res = await request(app).get(`/api/accounts/${created.id}/verify`);
    expect(res.status).toBe(200);
    expect(res.body.drift).toBe(0);
    expect(res.body.stored_balance).toBe(0);
    expect(res.body.computed_balance).toBe(0);
  });

  it("returns drift=0 after balanced debit+credit transactions", async () => {
    const { app } = await makeApp();
    const acc = (await request(app).post("/api/accounts").send(BASE_ACCOUNT)).body;
    await request(app).post("/api/transactions").send({ account_id: acc.id, date: "2025-01-01", description: "", amount_fx: 50, exchange_rate: 1, amount_usd: 50, type: "debit" });
    await request(app).post("/api/transactions").send({ account_id: acc.id, date: "2025-01-02", description: "", amount_fx: 30, exchange_rate: 1, amount_usd: 30, type: "credit" });
    const res = await request(app).get(`/api/accounts/${acc.id}/verify`);
    expect(res.body.computed_balance).toBeCloseTo(-20);
    expect(res.body.stored_balance).toBeCloseTo(-20);
    expect(res.body.drift).toBeCloseTo(0);
  });

  it("returns drift=0 for an opening balance (frozen-delta adjustment covers it)", async () => {
    const { app } = await makeApp();
    const acc = (await request(app).post("/api/accounts").send({ ...BASE_ACCOUNT, balance: 1000 })).body;
    // Creation writes an "Opening balance" adjustment, so the canonical
    // recompute reproduces the stored balance exactly -- creation can no
    // longer bypass the ledger.
    const res = await request(app).get(`/api/accounts/${acc.id}/verify`);
    expect(res.body.drift).toBeCloseTo(0);
    expect(res.body.stored_balance).toBeCloseTo(1000);
    expect(res.body.computed_balance).toBeCloseTo(1000);
  });

  it("returns non-zero drift when a write path truly bypasses the recompute", async () => {
    const { app, db } = await makeApp();
    const acc = (await request(app).post("/api/accounts").send(BASE_ACCOUNT)).body;
    // Simulate a rogue direct write (what the recompute invariant forbids).
    await db.update(accounts).set({ balance: 55500 }).where(eq(accounts.id, acc.id));
    const res = await request(app).get(`/api/accounts/${acc.id}/verify`);
    expect(res.body.drift).toBeCloseTo(-555);
  });

  it("returns 404 for unknown account", async () => {
    const { app } = await makeApp();
    const res = await request(app).get("/api/accounts/9999/verify");
    expect(res.status).toBe(404);
  });
});

describe("is_default flag", () => {
  it("defaults is_default to false on create", async () => {
    const { app } = await makeApp();
    const res = await request(app).post("/api/accounts").send(BASE_ACCOUNT);
    expect(res.body.is_default).toBe(false);
  });

  it("accepts is_default=true on create", async () => {
    const { app } = await makeApp();
    const res = await request(app).post("/api/accounts").send({ ...BASE_ACCOUNT, is_default: true });
    expect(res.body.is_default).toBe(true);
  });

  it("at most one account is_default at a time -- setting a new one clears the old", async () => {
    const { app } = await makeApp();
    const a1 = (await request(app).post("/api/accounts").send({ ...BASE_ACCOUNT, name: "A", is_default: true })).body;
    const a2 = (await request(app).post("/api/accounts").send({ ...BASE_ACCOUNT, name: "B", is_default: true })).body;

    const list = (await request(app).get("/api/accounts")).body;
    const a1Now = list.find((a: { id: number }) => a.id === a1.id);
    const a2Now = list.find((a: { id: number }) => a.id === a2.id);
    expect(a1Now.is_default).toBe(false);
    expect(a2Now.is_default).toBe(true);
  });

  it("PATCH is_default=true clears any other default", async () => {
    const { app } = await makeApp();
    const a1 = (await request(app).post("/api/accounts").send({ ...BASE_ACCOUNT, name: "A", is_default: true })).body;
    const a2 = (await request(app).post("/api/accounts").send({ ...BASE_ACCOUNT, name: "B" })).body;
    await request(app).patch(`/api/accounts/${a2.id}`).send({ is_default: true });

    const list = (await request(app).get("/api/accounts")).body;
    expect(list.find((a: { id: number }) => a.id === a1.id).is_default).toBe(false);
    expect(list.find((a: { id: number }) => a.id === a2.id).is_default).toBe(true);
  });

  it("PATCH is_default=false clears the flag without affecting others", async () => {
    const { app } = await makeApp();
    const a1 = (await request(app).post("/api/accounts").send({ ...BASE_ACCOUNT, name: "A", is_default: true })).body;
    await request(app).patch(`/api/accounts/${a1.id}`).send({ is_default: false });

    const list = (await request(app).get("/api/accounts")).body;
    expect(list.find((a: { id: number }) => a.id === a1.id).is_default).toBe(false);
  });
});

describe("is_active flag", () => {
  it("defaults is_active to true on create", async () => {
    const { app } = await makeApp();
    const res = await request(app).post("/api/accounts").send(BASE_ACCOUNT);
    expect(res.body.is_active).toBe(true);
  });

  it("GET exposes is_active on listed accounts", async () => {
    const { app } = await makeApp();
    await request(app).post("/api/accounts").send(BASE_ACCOUNT);
    const res = await request(app).get("/api/accounts");
    expect(res.body[0].is_active).toBe(true);
  });

  it("accepts is_active=false on create", async () => {
    const { app } = await makeApp();
    const res = await request(app).post("/api/accounts").send({ ...BASE_ACCOUNT, is_active: false });
    expect(res.body.is_active).toBe(false);
    const list = (await request(app).get("/api/accounts")).body;
    expect(list.find((a: { id: number }) => a.id === res.body.id).is_active).toBe(false);
  });

  it("PATCH can deactivate and reactivate an account without a reason", async () => {
    const { app } = await makeApp();
    const created = (await request(app).post("/api/accounts").send(BASE_ACCOUNT)).body;

    const off = await request(app).patch(`/api/accounts/${created.id}`).send({ is_active: false });
    expect(off.status).toBe(200);
    expect(off.body.is_active).toBe(false);

    const on = await request(app).patch(`/api/accounts/${created.id}`).send({ is_active: true });
    expect(on.body.is_active).toBe(true);
  });

  it("still returns inactive accounts from GET (reports/net worth include them)", async () => {
    const { app } = await makeApp();
    await request(app).post("/api/accounts").send({ ...BASE_ACCOUNT, name: "Active" });
    await request(app).post("/api/accounts").send({ ...BASE_ACCOUNT, name: "Legacy", is_active: false });
    const list = (await request(app).get("/api/accounts")).body;
    expect(list).toHaveLength(2);
    expect(list.map((a: { name: string }) => a.name).sort()).toEqual(["Active", "Legacy"]);
  });
});

describe("PATCH /api/accounts/reorder", () => {
  it("updates sort_order", async () => {
    const { app } = await makeApp();
    const a1 = (await request(app).post("/api/accounts").send({ ...BASE_ACCOUNT, name: "A" })).body;
    const a2 = (await request(app).post("/api/accounts").send({ ...BASE_ACCOUNT, name: "B" })).body;
    const res = await request(app).patch("/api/accounts/reorder").send({ order: [{ id: a1.id, sort_order: 2 }, { id: a2.id, sort_order: 1 }] });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});
