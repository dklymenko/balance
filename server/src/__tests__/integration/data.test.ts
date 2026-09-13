import { describe, it, expect } from "vitest";
import request from "supertest";
import { createApp } from "../../app.js";
import { createTestDb } from "../../test/db.js";

async function makeApp() {
  const db = await createTestDb();
  return { app: createApp(db), db };
}

// Every call hits one local database. Each test must use its own makeApp()
// instance for isolation.
const as = (app: ReturnType<typeof createApp>, _hid: string) => ({
  get: (url: string) => request(app).get(url),
  post: (url: string) => request(app).post(url),
});

function account(name: string) {
  return {
    name, account_type: "Checking", liquidity_type: "Liquid",
    base_currency: "USD", balance: 0, exchange_rate: 1, balance_usd: 0,
    ticker: null, shares_quantity: null, current_price_usd: null, notes: null,
  };
}

const H = "house-data";

describe("GET /api/data/export", () => {
  // The export is a versioned "Balance archive" -- the interchange format for
  // the desktop migration wizard and the local API data routes.
  // Money is integer cents (the storage convention), not API dollars.
  it("exports a versioned archive with money in integer cents and no household_id", async () => {
    const { app } = await makeApp();
    const acc = (await as(app, H).post("/api/accounts").send(account("Checking"))).body;
    const cat = (await as(app, H).post("/api/categories").send({ name: "Food" })).body;
    await as(app, H).post("/api/transactions").send({
      account_id: acc.id, category_id: cat.id, date: "2025-01-01", description: "lunch",
      amount_fx: 12.5, exchange_rate: 1, amount_usd: 12.5, type: "debit",
    });

    const res = await as(app, H).get("/api/data/export");
    expect(res.status).toBe(200);
    expect(res.body.format).toBe("balance-archive");
    expect(res.body.version).toBe(1);
    expect(res.body.accounts).toHaveLength(1);
    expect(res.body.accounts[0].household_id).toBeUndefined();
    expect(res.body.accounts[0].id).toBe(acc.id); // ids kept for reference remapping
    expect(res.body.categories).toHaveLength(1);
    expect(res.body.transactions).toHaveLength(1);
    expect(res.body.transactions[0].amount_usd).toBe(1250); // integer cents
    expect(res.body.transactions[0].amount_fx).toBe(1250);
    expect(res.body.transactions[0].household_id).toBeUndefined();
    expect(res.body.exported_at).toBeTruthy();
  });

});

describe("POST /api/data/import", () => {
  // A hand-built archive with deliberately sparse ids: the importer must
  // remap every reference, never trust archive ids.
  const archive = () => ({
    format: "balance-archive", version: 1, exported_at: "2026-07-13T00:00:00.000Z",
    accounts: [{
      id: 42, name: "Checking", account_type: "Checking", base_currency: "USD",
      liquidity_type: "Liquid", balance: 10050, exchange_rate: 1, balance_usd: 10050,
      ticker: null, shares_quantity: null, current_price_usd: null,
      sort_order: null, notes: null, is_default: false, is_active: true,
    }],
    categories: [
      { id: 7, name: "Food", parent_id: null, kind: "expense" },
      { id: 9, name: "Groceries", parent_id: 7, kind: "expense" },
    ],
    tags: [{ id: 5, name: "trip" }],
    transactions: [{
      id: 100, account_id: 42, category_id: 9, date: "2026-01-05", description: "lunch",
      amount_fx: 1250, exchange_rate: 1, amount_usd: 1250, type: "debit",
      exclude_from_reports: false,
    }],
    account_adjustments: [{ id: 3, account_id: 42, old_balance: 0, new_balance: 10050, reason: "initial" }],
    transaction_tags: [{ transaction_id: 100, tag_id: 5 }],
  });

  it("imports an archive into an empty household with ids remapped", async () => {
    const { app } = await makeApp();
    const res = await as(app, H).post("/api/data/import").send(archive());
    expect(res.status).toBe(201);
    expect(res.body.imported).toBe(7);
    expect(res.body.counts).toEqual({
      accounts: 1, categories: 2, tags: 1, transactions: 1,
      account_adjustments: 1, transaction_tags: 1,
    });

    const accs = (await as(app, H).get("/api/accounts")).body;
    expect(accs).toHaveLength(1);
    expect(accs[0].balance).toBeCloseTo(100.5); // cents in the archive, dollars out of the API
    const verification = await as(app, H).get(`/api/accounts/${accs[0].id}/verify`);
    expect(verification.body.drift).toBe(0);

    const cats = (await as(app, H).get("/api/categories")).body as { id: number; name: string; parent_id: number | null }[];
    const food = cats.find((c) => c.name === "Food")!;
    const groceries = cats.find((c) => c.name === "Groceries")!;
    expect(groceries.parent_id).toBe(food.id);

    const txs = (await as(app, H).get("/api/transactions")).body;
    expect(txs.total).toBe(1);
    expect(txs.rows[0].amount_usd).toBeCloseTo(12.5);
    expect(txs.rows[0].account_id).toBe(accs[0].id);
    expect(txs.rows[0].tags.map((t: { name: string }) => t.name)).toEqual(["trip"]);
  });

  it("round-trips its own export into a fresh database", async () => {
    const src = await makeApp();
    const acc = (await as(src.app, "rt").post("/api/accounts").send({
      ...account("Checking"), balance: 100, balance_usd: 100,
    })).body;
    const cat = (await as(src.app, "rt").post("/api/categories").send({ name: "Food" })).body;
    const tag = (await as(src.app, "rt").post("/api/tags").send({ name: "reviewed" })).body;
    const transaction = (await as(src.app, "rt").post("/api/transactions").send({
      account_id: acc.id, category_id: cat.id, date: "2025-01-01", description: "lunch",
      amount_fx: 12.5, exchange_rate: 1, amount_usd: 12.5, type: "debit",
    })).body;
    expect((await request(src.app).put(`/api/tags/transaction/${transaction.id}`).send({
      tag_ids: [tag.id],
    })).status).toBe(200);

    const exported = (await as(src.app, "rt").get("/api/data/export")).body;
    const dst = await makeApp();
    const res = await as(dst.app, "rt").post("/api/data/import").send(exported);
    expect(res.status).toBe(201);

    const a = (await as(src.app, "rt").get("/api/data/export")).body;
    const b = (await as(dst.app, "rt").get("/api/data/export")).body;
    expect(b.accounts).toHaveLength(a.accounts.length);
    expect(b.transactions).toHaveLength(a.transactions.length);
    expect(b.transactions[0].amount_usd).toBe(a.transactions[0].amount_usd);
    expect(b.accounts.map((row: { uuid: string }) => row.uuid)).toEqual(a.accounts.map((row: { uuid: string }) => row.uuid));
    expect(b.categories.map((row: { uuid: string }) => row.uuid)).toEqual(a.categories.map((row: { uuid: string }) => row.uuid));
    expect(b.tags.map((row: { uuid: string }) => row.uuid)).toEqual(a.tags.map((row: { uuid: string }) => row.uuid));
    expect(b.transactions.map((row: { uuid: string }) => row.uuid)).toEqual(a.transactions.map((row: { uuid: string }) => row.uuid));
    expect(b.account_adjustments.map((row: { uuid: string }) => row.uuid)).toEqual(a.account_adjustments.map((row: { uuid: string }) => row.uuid));
  });

  it("round-trips transfer direction without introducing balance drift", async () => {
    const src = await makeApp();
    const from = (await as(src.app, "rt").post("/api/accounts").send(account("Checking"))).body;
    const to = (await as(src.app, "rt").post("/api/accounts").send(account("Savings"))).body;
    await as(src.app, "rt").post("/api/transactions/transfer").send({
      from_account_id: from.id, to_account_id: to.id, date: "2026-01-05",
      description: "Synthetic move", amount_fx: 25,
    });
    const exported = (await as(src.app, "rt").get("/api/data/export")).body;
    expect(exported.transactions.map((row: { transfer_direction: string }) => row.transfer_direction).sort()).toEqual(["in", "out"]);

    const dst = await makeApp();
    expect((await as(dst.app, "rt").post("/api/data/import").send(exported)).status).toBe(201);
    const restoredAccounts = (await as(dst.app, "rt").get("/api/accounts")).body as { id: number }[];
    for (const restored of restoredAccounts) {
      const verification = await as(dst.app, "rt").get(`/api/accounts/${restored.id}/verify`);
      expect(verification.body.drift).toBe(0);
    }
  });

  it("re-import into a non-empty household returns 409 with imported: 0 (idempotent)", async () => {
    const { app } = await makeApp();
    expect((await as(app, H).post("/api/data/import").send(archive())).status).toBe(201);

    const second = await as(app, H).post("/api/data/import").send(archive());
    expect(second.status).toBe(409);
    expect(second.body.imported).toBe(0);
    expect((await as(app, H).get("/api/data/export")).body.transactions).toHaveLength(1);
  });

  it("allows only one of two concurrent restores into an empty ledger", async () => {
    const { app } = await makeApp();
    const [first, second] = await Promise.all([
      as(app, H).post("/api/data/import").send(archive()),
      as(app, H).post("/api/data/import").send(archive()),
    ]);
    expect([first.status, second.status].sort()).toEqual([201, 409]);
    expect((await as(app, H).get("/api/data/export")).body.accounts).toHaveLength(1);
  });

  it("rejects an unknown format/version and non-integer cents (400, nothing imported)", async () => {
    const { app } = await makeApp();
    expect((await as(app, H).post("/api/data/import").send({ version: 1 })).status).toBe(400);
    expect((await as(app, H).post("/api/data/import").send({ format: "balance-archive", version: 2 })).status).toBe(400);

    const bad = archive();
    bad.accounts[0].balance = 100.5 as unknown as number; // dollars snuck into a cents field
    expect((await as(app, H).post("/api/data/import").send(bad)).status).toBe(400);
    expect((await as(app, H).get("/api/data/export")).body.accounts).toHaveLength(0);
  });

  it("rejects dangling references and rolls the whole import back", async () => {
    const { app } = await makeApp();
    const bad = archive();
    bad.transactions[0].account_id = 999;
    expect((await as(app, H).post("/api/data/import").send(bad)).status).toBe(400);
    expect((await as(app, H).get("/api/data/export")).body.accounts).toHaveLength(0);
  });

  it("rejects an archive whose aggregate balance exceeds the supported range", async () => {
    const { app } = await makeApp();
    const bad = archive();
    bad.accounts[0].balance = 0;
    bad.accounts[0].balance_usd = 0;
    bad.account_adjustments = [];
    bad.transactions = [1, 2].map((id) => ({
      id,
      account_id: 42,
      category_id: null,
      date: "2026-01-05",
      description: `large credit ${id}`,
      amount_fx: 100_000_000_000_000,
      exchange_rate: 1,
      amount_usd: 100_000_000_000_000,
      type: "credit",
      exclude_from_reports: false,
    }));
    bad.transaction_tags = [];

    const res = await as(app, H).post("/api/data/import").send(bad);
    expect(res.status).toBe(400);
    expect(res.body.imported).toBe(0);
    expect(res.body.error).toMatch(/supported money range/i);
    expect((await as(app, H).get("/api/data/export")).body.accounts).toHaveLength(0);
  });

});

describe("GET /api/data/export/transactions.csv", () => {
  it("returns a CSV with a header and one row per transaction, properly escaped", async () => {
    const { app } = await makeApp();
    const acc = (await as(app, H).post("/api/accounts").send(account("Checking"))).body;
    await as(app, H).post("/api/transactions").send({
      account_id: acc.id, date: "2025-01-01", description: 'a,b "quoted"',
      amount_fx: 10, exchange_rate: 1, amount_usd: 10, type: "debit",
    });

    const res = await as(app, H).get("/api/data/export/transactions.csv");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.headers["content-disposition"]).toContain("attachment");
    const lines = res.text.trim().split("\n");
    expect(lines[0]).toContain("id,date,account,category,description");
    expect(lines).toHaveLength(2); // header + 1 row
    expect(lines[1]).toContain('"a,b ""quoted"""'); // comma + quotes escaped
  });

  it("neutralizes spreadsheet formulas in user-controlled text", async () => {
    const { app } = await makeApp();
    const acc = (await as(app, H).post("/api/accounts").send(account("Checking"))).body;
    await as(app, H).post("/api/transactions").send({
      account_id: acc.id, date: "2025-01-01", description: "=2+3",
      amount_fx: 10, exchange_rate: 1, type: "debit",
    });
    const res = await as(app, H).get("/api/data/export/transactions.csv");
    expect(res.text).toContain("'=2+3");
    expect(res.text).not.toContain(",=2+3,");
  });
});

describe("POST /api/data/reset (destructive)", () => {
  // Confirmation uses the fixed local name served by /api/me ("Balance").
  it("deletes financial data when confirm matches the local name", async () => {
    const { app } = await makeApp();
    const acc = (await as(app, H).post("/api/accounts").send(account("x"))).body;
    await as(app, H).post("/api/transactions").send({
      account_id: acc.id, date: "2025-01-01", description: "", amount_fx: 5, exchange_rate: 1, amount_usd: 5, type: "debit",
    });
    await as(app, H).post("/api/categories").send({ name: "C" });

    const res = await as(app, H).post("/api/data/reset").send({ confirm: "Balance" });
    expect(res.status).toBe(200);
    expect((await as(app, H).get("/api/accounts")).body).toHaveLength(0);
    expect((await as(app, H).get("/api/transactions")).body.total).toBe(0);
    expect((await as(app, H).get("/api/categories")).body).toHaveLength(0);
  });

  it("rejects reset with a non-matching confirm (400) and leaves data intact", async () => {
    const { app } = await makeApp();
    await as(app, H).post("/api/accounts").send(account("x"));
    expect((await as(app, H).post("/api/data/reset").send({ confirm: "wrong" })).status).toBe(400);
    expect((await as(app, H).get("/api/accounts")).body).toHaveLength(1);
  });
});

describe("POST /api/data/sample", () => {
  it("allows only one concurrent sample-data seed", async () => {
    const { app } = await makeApp();
    const [first, second] = await Promise.all([
      as(app, H).post("/api/data/sample"),
      as(app, H).post("/api/data/sample"),
    ]);
    expect([first.status, second.status].sort()).toEqual([201, 400]);
    const exported = (await as(app, H).get("/api/data/export")).body;
    expect(exported.accounts).toHaveLength(6);
  });
});
