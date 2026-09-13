import { describe, it, expect } from "vitest";
import request from "supertest";
import { createApp } from "../../app.js";
import { createTestDb } from "../../test/db.js";

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

async function createAccount(app: ReturnType<typeof createApp>, hid: string, name = "Checking", balance = 0) {
  const res = await as(app, hid).post("/api/accounts").send({
    name, account_type: "Checking", liquidity_type: "Liquid",
    base_currency: "USD", balance, exchange_rate: 1, balance_usd: balance,
  });
  return res.body as { id: number };
}

async function createCategory(app: ReturnType<typeof createApp>, hid: string, name: string, kind = "expense") {
  const res = await as(app, hid).post("/api/categories").send({ name, kind });
  return res.body as { id: number };
}

async function getBalance(app: ReturnType<typeof createApp>, hid: string, accountId: number): Promise<number> {
  const res = await as(app, hid).get("/api/accounts");
  return res.body.find((a: { id: number }) => a.id === accountId)?.balance ?? 0;
}

const row = (account_id: number, over: Record<string, unknown> = {}) => ({
  account_id, category_id: null, date: "2025-06-01", description: "Coffee",
  amount_fx: 10, exchange_rate: 1, type: "debit", tag_ids: [], ...over,
});

describe("POST /api/transactions/bulk", () => {
  it("creates all rows in one request and folds balance deltas per account", async () => {
    const { app } = await makeApp();
    const acc1 = await createAccount(app, A, "Checking");
    const acc2 = await createAccount(app, A, "Savings");

    const res = await as(app, A).post("/api/transactions/bulk").send({
      rows: [
        row(acc1.id, { amount_fx: 50, type: "debit" }),
        row(acc1.id, { amount_fx: 200, type: "credit" }),
        row(acc2.id, { amount_fx: 30, type: "debit" }),
      ],
    });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ created: 3 });

    expect(await getBalance(app, A, acc1.id)).toBeCloseTo(150); // -50 + 200
    expect(await getBalance(app, A, acc2.id)).toBeCloseTo(-30);
    const list = await as(app, A).get("/api/transactions");
    expect(list.body.total).toBe(3);
  });

  it("derives amount_usd server-side, ignoring a tampered client value", async () => {
    const { app } = await makeApp();
    const acc = await createAccount(app, A);
    await as(app, A).post("/api/transactions/bulk").send({
      rows: [row(acc.id, { amount_fx: 10, amount_usd: 999999 })],
    });
    const list = await as(app, A).get("/api/transactions");
    expect(list.body.rows[0].amount_usd).toBeCloseTo(10);
  });

  it("attaches per-row tags", async () => {
    const { app } = await makeApp();
    const acc = await createAccount(app, A);
    const tag = (await as(app, A).post("/api/tags").send({ name: "trip" })).body as { id: number };

    await as(app, A).post("/api/transactions/bulk").send({
      rows: [row(acc.id, { tag_ids: [tag.id] }), row(acc.id)],
    });
    const list = await as(app, A).get("/api/transactions");
    const tagged = list.body.rows.filter((r: { tags: unknown[] }) => r.tags.length > 0);
    expect(tagged).toHaveLength(1);
    expect(tagged[0].tags[0].name).toBe("trip");
  });

  it("normalizes duplicate tag ids instead of failing the whole import", async () => {
    const { app } = await makeApp();
    const acc = await createAccount(app, A);
    const tag = (await as(app, A).post("/api/tags").send({ name: "trip" })).body as { id: number };

    const created = await as(app, A).post("/api/transactions/bulk").send({
      rows: [row(acc.id, { tag_ids: [tag.id, tag.id] })],
    });
    expect(created.status).toBe(201);
    const list = await as(app, A).get("/api/transactions");
    expect(list.body.rows[0].tags).toEqual([{ id: tag.id, name: "trip" }]);
  });

  it("rejects the whole batch on an invalid row and inserts nothing", async () => {
    const { app } = await makeApp();
    const acc = await createAccount(app, A);
    const bad = await as(app, A).post("/api/transactions/bulk").send({
      rows: [row(acc.id), row(acc.id, { amount_fx: -5 })],
    });
    expect(bad.status).toBe(400);
    expect((await as(app, A).get("/api/transactions")).body.total).toBe(0);
    expect(await getBalance(app, A, acc.id)).toBeCloseTo(0);
  });

  it("rejects transfer rows (transfers stay on /transfer)", async () => {
    const { app } = await makeApp();
    const acc = await createAccount(app, A);
    const res = await as(app, A).post("/api/transactions/bulk").send({
      rows: [row(acc.id, { type: "transfer" })],
    });
    expect(res.status).toBe(400);
  });

  it("rejects rows referencing a nonexistent account (nothing inserted)", async () => {
    const { app } = await makeApp();
    const acc = await createAccount(app, A);

    const res = await as(app, A).post("/api/transactions/bulk").send({
      rows: [row(acc.id), row(acc.id + 999)],
    });
    expect(res.status).toBe(400);
    expect((await as(app, A).get("/api/transactions")).body.total).toBe(0);
  });

  it("rejects rows referencing a nonexistent category", async () => {
    const { app } = await makeApp();
    const acc = await createAccount(app, A);

    const res = await as(app, A).post("/api/transactions/bulk").send({
      rows: [row(acc.id, { category_id: 999 })],
    });
    expect(res.status).toBe(400);
  });

  it("rejects an income category on a debit row", async () => {
    const { app } = await makeApp();
    const acc = await createAccount(app, A);
    const salary = await createCategory(app, A, "Salary", "income");
    const res = await as(app, A).post("/api/transactions/bulk").send({
      rows: [row(acc.id, { category_id: salary.id, type: "debit" })],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/income category/);
  });
});

describe("POST /api/transactions/suggest-categories", () => {
  it("suggests the category last used for the same merchant, ignoring descriptor noise", async () => {
    const { app } = await makeApp();
    const acc = await createAccount(app, A);
    const dining = await createCategory(app, A, "Dining");
    const groceries = await createCategory(app, A, "Groceries");

    await as(app, A).post("/api/transactions/bulk").send({
      rows: [
        row(acc.id, { description: "STARBUCKS #0012 SEATTLE", category_id: dining.id }),
        row(acc.id, { description: "FreshMart 44 Main St", category_id: groceries.id }),
      ],
    });

    const res = await as(app, A).post("/api/transactions/suggest-categories").send({
      descriptions: ["STARBUCKS #9931 SEATTLE", "freshmart 902 main st", "Unknown Merchant"],
    });
    expect(res.status).toBe(200);
    expect(res.body.suggestions).toEqual([dining.id, groceries.id, null]);
  });

  it("prefers the most recent categorization when a merchant was re-categorized", async () => {
    const { app } = await makeApp();
    const acc = await createAccount(app, A);
    const dining = await createCategory(app, A, "Dining");
    const coffee = await createCategory(app, A, "Coffee");

    await as(app, A).post("/api/transactions/bulk").send({
      rows: [row(acc.id, { description: "Corner Cafe", category_id: dining.id, date: "2025-01-01" })],
    });
    await as(app, A).post("/api/transactions/bulk").send({
      rows: [row(acc.id, { description: "CORNER CAFE 22", category_id: coffee.id, date: "2025-02-01" })],
    });

    const res = await as(app, A).post("/api/transactions/suggest-categories").send({
      descriptions: ["Corner Cafe #7"],
    });
    expect(res.body.suggestions).toEqual([coffee.id]);
  });


  it("400s on a malformed body", async () => {
    const { app } = await makeApp();
    expect((await as(app, A).post("/api/transactions/suggest-categories").send({})).status).toBe(400);
    expect((await as(app, A).post("/api/transactions/suggest-categories").send({ descriptions: [1] })).status).toBe(400);
  });
});
