import { describe, expect, it } from "vitest";
import request from "supertest";
import Database from "better-sqlite3";
import { createApp } from "../../app.js";
import { createTestDb } from "../../test/db.js";

// Regression: amount_fx and exchange_rate are each bounded, but their product
// was not. A request could store a derived amount_usd past the JS safe-integer
// range, which SQLite keeps in an integer column with REAL affinity. That ends
// exact-cents arithmetic and -- demonstrated below -- makes the ledger's own
// archive export fail its own import validation, so the user's backup could no
// longer be restored.

async function makeApp() {
  return createApp(await createTestDb());
}

const account = {
  name: "Synthetic Checking", account_type: "Checking", liquidity_type: "Liquid",
  base_currency: "USD", balance: 0, exchange_rate: 1,
};

// The largest amount and rate each validator accepts on its own.
const MAX_AMOUNT = 1e12;
const MAX_RATE = 1e9;

async function makeAccount(app: ReturnType<typeof createApp>, overrides = {}) {
  const res = await request(app).post("/api/accounts").send({ ...account, ...overrides });
  expect(res.status).toBe(201);
  return res.body;
}

describe("derived money values stay inside the storable cents range", () => {
  it("rejects a single transaction whose amount x rate overflows", async () => {
    const app = await makeApp();
    const acct = await makeAccount(app);
    const res = await request(app).post("/api/transactions").send({
      account_id: acct.id, date: "2026-01-15", amount_fx: MAX_AMOUNT, exchange_rate: MAX_RATE, type: "debit",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/supported money range/);
    expect((await request(app).get("/api/transactions")).body.total).toBe(0);
  });

  it("rejects an overflowing bulk row and writes nothing", async () => {
    const app = await makeApp();
    const acct = await makeAccount(app);
    const res = await request(app).post("/api/transactions/bulk").send({
      rows: [
        { account_id: acct.id, date: "2026-01-15", amount_fx: 10, type: "debit" },
        { account_id: acct.id, date: "2026-01-16", amount_fx: MAX_AMOUNT, exchange_rate: MAX_RATE, type: "debit" },
      ],
    });
    expect(res.status).toBe(400);
    expect((await request(app).get("/api/transactions")).body.total).toBe(0);
  });

  it("rejects an overflowing PATCH and leaves the original row intact", async () => {
    const app = await makeApp();
    const acct = await makeAccount(app);
    const created = (await request(app).post("/api/transactions").send({
      account_id: acct.id, date: "2026-01-15", amount_fx: 25, type: "debit",
    })).body;
    const res = await request(app).patch(`/api/transactions/${created.id}`).send({
      account_id: acct.id, date: "2026-01-15", amount_fx: MAX_AMOUNT, exchange_rate: MAX_RATE, type: "debit",
    });
    expect(res.status).toBe(400);
    const after = (await request(app).get("/api/transactions")).body.rows[0];
    expect(after.amount_fx).toBe(25);
    expect(after.amount_usd).toBe(25);
  });

  it("rejects a transfer whose converted amount overflows", async () => {
    const app = await makeApp();
    const from = await makeAccount(app, { name: "High rate", exchange_rate: MAX_RATE });
    const to = await makeAccount(app, { name: "Destination" });
    const res = await request(app).post("/api/transactions/transfer").send({
      from_account_id: from.id, to_account_id: to.id, date: "2026-01-15",
      description: "overflow", amount_fx: MAX_AMOUNT,
    });
    expect(res.status).toBe(400);
    expect((await request(app).get("/api/transactions")).body.total).toBe(0);
  });

  it("rejects a transaction that would overflow the account's own balance_usd", async () => {
    const app = await makeApp();
    // The account rate is separate from the transaction rate, so an in-range
    // transaction can still push the recomputed balance_usd out of range.
    const acct = await makeAccount(app, { exchange_rate: MAX_RATE });
    const res = await request(app).post("/api/transactions").send({
      account_id: acct.id, date: "2026-01-15", amount_fx: MAX_AMOUNT, type: "credit",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/supported money range/);
    const fresh = (await request(app).get("/api/accounts")).body[0];
    expect(fresh.balance).toBe(0);
  });

  it("rejects an opening balance that would overflow balance_usd", async () => {
    const app = await makeApp();
    const res = await request(app).post("/api/accounts")
      .send({ ...account, balance: MAX_AMOUNT, exchange_rate: MAX_RATE });
    expect(res.status).toBe(400);
    expect((await request(app).get("/api/accounts")).body).toHaveLength(0);
  });

  it("still accepts the largest genuinely representable amounts", async () => {
    const app = await makeApp();
    const acct = await makeAccount(app);
    const res = await request(app).post("/api/transactions").send({
      account_id: acct.id, date: "2026-01-15", amount_fx: MAX_AMOUNT, exchange_rate: 1, type: "debit",
    });
    expect(res.status).toBe(201);
    expect(res.body.amount_usd).toBe(MAX_AMOUNT);
  });

  it("round-trips the maximum supported value as exact cents through the API", async () => {
    const app = await makeApp();
    const acct = await makeAccount(app);
    await request(app).post("/api/transactions").send({
      account_id: acct.id, date: "2026-01-15", amount_fx: MAX_AMOUNT, exchange_rate: 1, type: "debit",
    });
    const rows = (await request(app).get("/api/transactions")).body.rows;
    expect(rows).toHaveLength(1);
    expect(Number.isSafeInteger(Math.round(rows[0].amount_usd * 100))).toBe(true);
  });

  it("guards the affinity check itself against a genuine float", () => {
    // Proves the assertion above can fail: SQLite really does store an
    // out-of-range value as REAL in an INTEGER column.
    const raw = new Database(":memory:");
    raw.exec("CREATE TABLE t (v INTEGER)");
    raw.prepare("INSERT INTO t (v) VALUES (?)").run(1e23);
    expect(raw.prepare("SELECT typeof(v) AS t FROM t").get()).toEqual({ t: "real" });
    raw.close();
  });

  it("round-trips its own export through import after the guard", async () => {
    const app = await makeApp();
    const acct = await makeAccount(app);
    // The largest values the API now accepts must survive export and import.
    await request(app).post("/api/transactions").send({
      account_id: acct.id, date: "2026-01-15", amount_fx: MAX_AMOUNT, exchange_rate: 1, type: "debit",
    });
    const archive = (await request(app).get("/api/data/export")).body;

    const fresh = await makeApp();
    const imported = await request(fresh).post("/api/data/import").send(archive);
    expect(imported.status).toBe(201);
    expect(imported.body.counts.transactions).toBe(1);
  });
});
