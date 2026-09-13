import { describe, it, expect } from "vitest";
import request from "supertest";
import { createApp } from "../../app.js";
import { createTestDb } from "../../test/db.js";
import { accounts } from "../../db/schema.js";

async function makeApp() {
  const db = await createTestDb();
  return { app: createApp(db), db };
}

async function createAccount(app: ReturnType<typeof createApp>, balance = 0) {
  const res = await request(app).post("/api/accounts").send({
    name: "Test", account_type: "Checking", liquidity_type: "Liquid",
    base_currency: "USD", balance, exchange_rate: 1, balance_usd: balance,
    ticker: null, shares_quantity: null, current_price_usd: null, notes: null,
  });
  return res.body as { id: number; balance: number };
}

async function getBalance(app: ReturnType<typeof createApp>, accountId: number): Promise<number> {
  const res = await request(app).get("/api/accounts");
  return res.body.find((a: { id: number }) => a.id === accountId)?.balance ?? 0;
}

describe("POST /api/transactions", () => {
  it("debit decreases account balance", async () => {
    const { app } = await makeApp();
    const acc = await createAccount(app, 0);
    await request(app).post("/api/transactions").send({ account_id: acc.id, date: "2025-01-01", description: "", amount_fx: 50, exchange_rate: 1, amount_usd: 50, type: "debit" });
    expect(await getBalance(app, acc.id)).toBeCloseTo(-50);
  });

  it("credit increases account balance", async () => {
    const { app } = await makeApp();
    const acc = await createAccount(app, 0);
    await request(app).post("/api/transactions").send({ account_id: acc.id, date: "2025-01-01", description: "", amount_fx: 100, exchange_rate: 1, amount_usd: 100, type: "credit" });
    expect(await getBalance(app, acc.id)).toBeCloseTo(100);
  });

  it("returns 201 with tags array", async () => {
    const { app } = await makeApp();
    const acc = await createAccount(app);
    const res = await request(app).post("/api/transactions").send({ account_id: acc.id, date: "2025-01-01", description: "", amount_fx: 10, exchange_rate: 1, amount_usd: 10, type: "debit" });
    expect(res.status).toBe(201);
    expect(res.body.tags).toEqual([]);
  });

  it("derives amount_usd server-side, ignoring a tampered client value", async () => {
    const { app } = await makeApp();
    const acc = await createAccount(app, 0);
    // Client lies: amount_fx=10, rate=1, but amount_usd=999999.
    const res = await request(app).post("/api/transactions").send({
      account_id: acc.id, date: "2025-01-01", description: "", amount_fx: 10, exchange_rate: 1, amount_usd: 999999, type: "debit",
    });
    expect(res.status).toBe(201);
    expect(res.body.amount_usd).toBeCloseTo(10); // recomputed = amount_fx × rate
    expect(await getBalance(app, acc.id)).toBeCloseTo(-10);
  });

  it("derives amount_usd from amount_fx × exchange_rate for FX accounts", async () => {
    const { app } = await makeApp();
    const acc = await createAccount(app, 0);
    const res = await request(app).post("/api/transactions").send({
      account_id: acc.id, date: "2025-01-01", description: "", amount_fx: 10, exchange_rate: 2, amount_usd: 1, type: "debit",
    });
    expect(res.status).toBe(201);
    expect(res.body.amount_usd).toBeCloseTo(20);
  });

  it("rejects an invalid transaction type with 400", async () => {
    const { app } = await makeApp();
    const acc = await createAccount(app);
    const res = await request(app).post("/api/transactions").send({
      account_id: acc.id, date: "2025-01-01", description: "", amount_fx: 10, exchange_rate: 1, amount_usd: 10, type: "wizardry",
    });
    expect(res.status).toBe(400);
  });

  it("rejects standalone transfer legs and ignores protected storage fields", async () => {
    const { app } = await makeApp();
    const acc = await createAccount(app);
    const transfer = await request(app).post("/api/transactions").send({
      account_id: acc.id, date: "2025-01-01", description: "", amount_fx: 10,
      exchange_rate: 1, type: "transfer", transfer_direction: "in",
    });
    expect(transfer.status).toBe(400);

    const debit = await request(app).post("/api/transactions").send({
      account_id: acc.id, date: "2025-01-01", description: "", amount_fx: 10,
      exchange_rate: 1, type: "debit", uuid: "attacker-controlled",
      transfer_group_id: "attacker-controlled", transfer_direction: "in",
    });
    expect(debit.status).toBe(201);
    expect(debit.body.uuid).not.toBe("attacker-controlled");
    expect(debit.body.transfer_group_id).toBeNull();
    expect(debit.body.transfer_direction).toBeNull();
  });
});

describe("PATCH /api/transactions/:id recomputes amount_usd", () => {
  it("ignores a tampered amount_usd on update", async () => {
    const { app } = await makeApp();
    const acc = await createAccount(app, 0);
    const tx = (await request(app).post("/api/transactions").send({ account_id: acc.id, date: "2025-01-01", description: "", amount_fx: 50, exchange_rate: 1, amount_usd: 50, type: "debit" })).body;
    const res = await request(app).patch(`/api/transactions/${tx.id}`).send({
      account_id: acc.id, date: "2025-01-01", description: "", amount_fx: 30, exchange_rate: 1, amount_usd: 999999, type: "debit",
    });
    expect(res.status).toBe(200);
    expect(res.body.amount_usd).toBeCloseTo(30);
    expect(await getBalance(app, acc.id)).toBeCloseTo(-30);
  });

  it("keeps every account balance correct when two moves race", async () => {
    const { app } = await makeApp();
    const original = await createAccount(app, 0);
    const firstTarget = await createAccount(app, 0);
    const secondTarget = await createAccount(app, 0);
    const transaction = (await request(app).post("/api/transactions").send({
      account_id: original.id,
      date: "2026-01-01",
      description: "Synthetic move",
      amount_fx: 10,
      exchange_rate: 1,
      type: "debit",
    })).body as { id: number };

    const payload = {
      date: "2026-01-01",
      description: "Synthetic move",
      amount_fx: 10,
      exchange_rate: 1,
      type: "debit",
    };
    const responses = await Promise.all([
      request(app).patch(`/api/transactions/${transaction.id}`).send({ ...payload, account_id: firstTarget.id }),
      request(app).patch(`/api/transactions/${transaction.id}`).send({ ...payload, account_id: secondTarget.id }),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);

    const current = (await request(app).get("/api/transactions")).body.rows
      .find((row: { id: number }) => row.id === transaction.id) as { account_id: number };
    for (const account of [original, firstTarget, secondTarget]) {
      expect(await getBalance(app, account.id)).toBe(account.id === current.account_id ? -10 : 0);
    }
  });
});

describe("GET /api/transactions input validation", () => {
  it("rejects malformed list, pagination, range, date, and search filters", async () => {
    const { app } = await makeApp();
    const badQueries = [
      "account_ids=1,nope",
      "account_ids=1.5",
      "category_ids=-1",
      "account_id=1.5",
      "category_id=0",
      "tag_id=1.5",
      "limit=1.5",
      "offset=2.5",
      "amount_min=-1",
      "amount_max=1000000000001",
      "amount_min=20&amount_max=10",
      "date_from=2026-02-30",
      "date_from=2026-03-02&date_to=2026-03-01",
      `search=${"x".repeat(501)}`,
    ];
    for (const query of badQueries) {
      const response = await request(app).get(`/api/transactions?${query}`);
      expect(response.status, query).toBe(400);
    }
  });

  it("rejects a non-numeric category_id with 400 (not 500)", async () => {
    const { app } = await makeApp();
    const res = await request(app).get("/api/transactions?category_id=abc");
    expect(res.status).toBe(400);
  });

  it("rejects a SQL-ish category_id with 400", async () => {
    const { app } = await makeApp();
    const res = await request(app).get("/api/transactions?category_id=1 OR 1=1");
    expect(res.status).toBe(400);
  });

  it("rejects a negative offset with 400", async () => {
    const { app } = await makeApp();
    const res = await request(app).get("/api/transactions?offset=-5");
    expect(res.status).toBe(400);
  });

  it("rejects a non-finite amount_min with 400", async () => {
    const { app } = await makeApp();
    const res = await request(app).get("/api/transactions?amount_min=1e9999");
    expect(res.status).toBe(400);
  });

  it("treats an enormous numeric-looking search as text instead of overflowing SQLite", async () => {
    const { app } = await makeApp();
    const res = await request(app).get("/api/transactions?search=1e100");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ rows: [], total: 0 });
  });
});

describe("DELETE /api/transactions/:id", () => {
  it("reverses balance on delete", async () => {
    const { app } = await makeApp();
    const acc = await createAccount(app, 0);
    const tx = (await request(app).post("/api/transactions").send({ account_id: acc.id, date: "2025-01-01", description: "", amount_fx: 50, exchange_rate: 1, amount_usd: 50, type: "debit" })).body;
    expect(await getBalance(app, acc.id)).toBeCloseTo(-50);
    await request(app).delete(`/api/transactions/${tx.id}`);
    expect(await getBalance(app, acc.id)).toBeCloseTo(0);
  });

  it("returns 404 for unknown transaction", async () => {
    const { app } = await makeApp();
    const res = await request(app).delete("/api/transactions/9999");
    expect(res.status).toBe(404);
  });

  it("deletes both linked transfer legs atomically when either leg is selected", async () => {
    const { app } = await makeApp();
    const from = await createAccount(app, 100);
    const to = await createAccount(app, 0);
    const created = await request(app).post("/api/transactions/transfer").send({
      from_account_id: from.id, to_account_id: to.id, date: "2025-01-01",
      description: "move", amount_fx: 25,
    });
    expect(created.status).toBe(201);

    const deleted = await request(app).delete(`/api/transactions/${created.body[1].id}`);
    expect(deleted.status).toBe(204);
    expect((await request(app).get("/api/transactions")).body.total).toBe(0);
    expect(await getBalance(app, from.id)).toBeCloseTo(100);
    expect(await getBalance(app, to.id)).toBeCloseTo(0);
  });
});

describe("POST /api/transactions/transfer", () => {
  it("debits from-account and credits to-account", async () => {
    const { app } = await makeApp();
    const from = await createAccount(app, 500);
    const to = await createAccount(app, 0);
    await request(app).post("/api/transactions/transfer").send({ from_account_id: from.id, to_account_id: to.id, date: "2025-01-01", description: "move", amount_fx: 100 });
    expect(await getBalance(app, from.id)).toBeCloseTo(400);
    expect(await getBalance(app, to.id)).toBeCloseTo(100);
  });

  it("creates two transaction rows with type=transfer", async () => {
    const { app } = await makeApp();
    const from = await createAccount(app, 0);
    const to = await createAccount(app, 0);
    const res = await request(app).post("/api/transactions/transfer").send({ from_account_id: from.id, to_account_id: to.id, date: "2025-01-01", description: "", amount_fx: 50 });
    expect(res.status).toBe(201);
    expect(res.body).toHaveLength(2);
    expect(res.body.every((r: { type: string }) => r.type === "transfer")).toBe(true);
  });

  it("preserves value across currencies using each account's native amount", async () => {
    const { app } = await makeApp();
    const from = (await request(app).post("/api/accounts").send({
      name: "Euro", account_type: "Checking", liquidity_type: "Liquid",
      base_currency: "EUR", balance: 100, exchange_rate: 1.2, balance_usd: 120,
    })).body as { id: number };
    const to = (await request(app).post("/api/accounts").send({
      name: "Dollar", account_type: "Checking", liquidity_type: "Liquid",
      base_currency: "USD", balance: 0, exchange_rate: 1, balance_usd: 0,
    })).body as { id: number };

    const res = await request(app).post("/api/transactions/transfer").send({
      from_account_id: from.id, to_account_id: to.id, date: "2025-01-01",
      description: "FX move", amount_fx: 10,
    });
    expect(res.status).toBe(201);
    expect(res.body[0]).toMatchObject({ amount_fx: 10, amount_usd: 12, exchange_rate: 1.2, transfer_direction: "out" });
    expect(res.body[1]).toMatchObject({ amount_fx: 12, amount_usd: 12, exchange_rate: 1, transfer_direction: "in" });
    expect(await getBalance(app, from.id)).toBeCloseTo(90);
    expect(await getBalance(app, to.id)).toBeCloseTo(12);
  });

  it("updates both linked legs atomically", async () => {
    const { app } = await makeApp();
    const from = await createAccount(app, 100);
    const to = await createAccount(app, 0);
    const created = await request(app).post("/api/transactions/transfer").send({
      from_account_id: from.id, to_account_id: to.id, date: "2025-01-01",
      description: "move", amount_fx: 25,
    });
    const groupId = created.body[0].transfer_group_id as string;

    const updated = await request(app).patch(`/api/transactions/transfer/${groupId}`).send({
      from_account_id: from.id, to_account_id: to.id, date: "2025-01-02",
      description: "updated", amount_fx: 30,
    });
    expect(updated.status).toBe(200);
    expect(updated.body).toHaveLength(2);
    expect(updated.body.every((row: { description: string }) => row.description === "updated")).toBe(true);
    expect(await getBalance(app, from.id)).toBeCloseTo(70);
    expect(await getBalance(app, to.id)).toBeCloseTo(30);
  });
});

describe("GET /api/transactions -- transfer counterparty", () => {
  async function createNamedAccount(app: ReturnType<typeof createApp>, name: string) {
    const res = await request(app).post("/api/accounts").send({
      name, account_type: "Checking", liquidity_type: "Liquid",
      base_currency: "USD", balance: 0, exchange_rate: 1, balance_usd: 0,
      ticker: null, shares_quantity: null, current_price_usd: null, notes: null,
    });
    return res.body as { id: number };
  }

  it("returns from/to account names for a transfer leg even when filtered to one account", async () => {
    const { app } = await makeApp();
    const from = await createNamedAccount(app, "Checking");
    const to = await createNamedAccount(app, "Savings");
    await request(app).post("/api/transactions/transfer").send({
      from_account_id: from.id, to_account_id: to.id, date: "2025-01-01", description: "", amount_fx: 100,
    });

    // Filter to just the source account: only the from-leg is returned, but it
    // still knows the destination side.
    const fromView = await request(app).get(`/api/transactions?account_ids=${from.id}`);
    expect(fromView.body.rows).toHaveLength(1);
    expect(fromView.body.rows[0].type).toBe("transfer");
    expect(fromView.body.rows[0].transfer_from).toBe("Checking");
    expect(fromView.body.rows[0].transfer_to).toBe("Savings");

    // Filter to just the destination account: the to-leg shows the same direction.
    const toView = await request(app).get(`/api/transactions?account_ids=${to.id}`);
    expect(toView.body.rows).toHaveLength(1);
    expect(toView.body.rows[0].transfer_from).toBe("Checking");
    expect(toView.body.rows[0].transfer_to).toBe("Savings");
  });
});

describe("PATCH /api/transactions/:id", () => {
  it("returns 404 for unknown transaction", async () => {
    const { app } = await makeApp();
    const acc = await createAccount(app);
    const res = await request(app).patch("/api/transactions/9999").send({ account_id: acc.id, date: "2025-01-01", description: "", amount_fx: 10, exchange_rate: 1, amount_usd: 10, type: "debit" });
    expect(res.status).toBe(404);
  });

  it("updates balance when amount changes on same account", async () => {
    const { app } = await makeApp();
    const acc = await createAccount(app, 0);
    const tx = (await request(app).post("/api/transactions").send({ account_id: acc.id, date: "2025-01-01", description: "", amount_fx: 50, exchange_rate: 1, amount_usd: 50, type: "debit" })).body;
    await request(app).patch(`/api/transactions/${tx.id}`).send({ account_id: acc.id, date: "2025-01-01", description: "", amount_fx: 30, exchange_rate: 1, amount_usd: 30, type: "debit" });
    expect(await getBalance(app, acc.id)).toBeCloseTo(-30);
  });

  it("rejects changing a normal transaction into a transfer", async () => {
    const { app } = await makeApp();
    const acc = await createAccount(app, 0);
    const tx = (await request(app).post("/api/transactions").send({
      account_id: acc.id, date: "2025-01-01", description: "", amount_fx: 10,
      exchange_rate: 1, type: "debit",
    })).body;
    const res = await request(app).patch(`/api/transactions/${tx.id}`).send({
      account_id: acc.id, date: "2025-01-01", description: "", amount_fx: 10,
      exchange_rate: 1, type: "transfer",
    });
    expect(res.status).toBe(400);
  });

  it("keeps every affected balance correct when two edits race", async () => {
    const { app } = await makeApp();
    const original = await createAccount(app, 0);
    const second = await createAccount(app, 0);
    const third = await createAccount(app, 0);
    const transaction = (await request(app).post("/api/transactions").send({
      account_id: original.id, date: "2026-04-01", description: "before",
      amount_fx: 10, exchange_rate: 1, type: "debit",
    })).body;

    const edit = (accountId: number, amount: number, type: "debit" | "credit") =>
      request(app).patch(`/api/transactions/${transaction.id}`).send({
        account_id: accountId, date: "2026-04-02", description: "raced edit",
        amount_fx: amount, exchange_rate: 1, type,
      });
    const responses = await Promise.all([
      edit(second.id, 20, "debit"),
      edit(third.id, 30, "credit"),
    ]);
    expect(responses.every((response) => response.status === 200)).toBe(true);

    const final = (await request(app).get("/api/transactions")).body.rows[0] as {
      account_id: number; amount_fx: number; type: "debit" | "credit";
    };
    const expected = final.type === "credit" ? final.amount_fx : -final.amount_fx;
    for (const account of [original, second, third]) {
      expect(await getBalance(app, account.id)).toBe(account.id === final.account_id ? expected : 0);
    }
  });
});

describe("GET /api/transactions", () => {
  it("returns { rows, total } ordered by date desc", async () => {
    const { app } = await makeApp();
    const acc = await createAccount(app);
    await request(app).post("/api/transactions").send({ account_id: acc.id, date: "2025-01-01", description: "first", amount_fx: 10, exchange_rate: 1, amount_usd: 10, type: "debit" });
    await request(app).post("/api/transactions").send({ account_id: acc.id, date: "2025-01-03", description: "second", amount_fx: 20, exchange_rate: 1, amount_usd: 20, type: "credit" });
    const res = await request(app).get("/api/transactions");
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.rows[0].description).toBe("second");
  });

  it("paginates with limit/offset while reporting the full total", async () => {
    const { app } = await makeApp();
    const acc = await createAccount(app);
    for (let i = 0; i < 5; i++) {
      await request(app).post("/api/transactions").send({ account_id: acc.id, date: `2025-01-0${i + 1}`, description: `tx${i}`, amount_fx: 1, exchange_rate: 1, amount_usd: 1, type: "debit" });
    }
    const page1 = await request(app).get("/api/transactions?limit=2&offset=0");
    expect(page1.body.total).toBe(5);
    expect(page1.body.rows).toHaveLength(2);
    expect(page1.body.rows[0].description).toBe("tx4"); // newest date first
    const page2 = await request(app).get("/api/transactions?limit=2&offset=2");
    expect(page2.body.rows.map((r: { description: string }) => r.description)).toEqual(["tx2", "tx1"]);
    const page3 = await request(app).get("/api/transactions?limit=2&offset=4");
    expect(page3.body.rows).toHaveLength(1);
    expect(page3.body.rows[0].description).toBe("tx0");
  });

  it("filters by account_ids, category_id and amount range", async () => {
    const { app } = await makeApp();
    const a1 = await createAccount(app);
    const a2 = await createAccount(app);
    const cat = (await request(app).post("/api/categories").send({ name: "Food" })).body as { id: number };
    await request(app).post("/api/transactions").send({ account_id: a1.id, category_id: cat.id, date: "2025-02-01", description: "groceries", amount_fx: 30, exchange_rate: 1, amount_usd: 30, type: "debit" });
    await request(app).post("/api/transactions").send({ account_id: a2.id, date: "2025-02-02", description: "other", amount_fx: 200, exchange_rate: 1, amount_usd: 200, type: "debit" });

    const byAcct = await request(app).get(`/api/transactions?account_ids=${a1.id}`);
    expect(byAcct.body.total).toBe(1);
    expect(byAcct.body.rows[0].description).toBe("groceries");

    const byCat = await request(app).get(`/api/transactions?category_id=${cat.id}`);
    expect(byCat.body.total).toBe(1);
    expect(byCat.body.rows[0].description).toBe("groceries");

    const byAmount = await request(app).get(`/api/transactions?amount_min=100`);
    expect(byAmount.body.total).toBe(1);
    expect(byAmount.body.rows[0].description).toBe("other");
  });

  it("filters by an inclusive date range (date_from / date_to)", async () => {
    const { app } = await makeApp();
    const acc = await createAccount(app);
    await request(app).post("/api/transactions").send({ account_id: acc.id, date: "2025-03-01", description: "jan-ish", amount_fx: 1, exchange_rate: 1, amount_usd: 1, type: "debit" });
    await request(app).post("/api/transactions").send({ account_id: acc.id, date: "2025-03-15", description: "mid", amount_fx: 1, exchange_rate: 1, amount_usd: 1, type: "debit" });
    await request(app).post("/api/transactions").send({ account_id: acc.id, date: "2025-04-05", description: "later", amount_fx: 1, exchange_rate: 1, amount_usd: 1, type: "debit" });

    const inRange = await request(app).get("/api/transactions?date_from=2025-03-10&date_to=2025-03-31");
    expect(inRange.body.total).toBe(1);
    expect(inRange.body.rows[0].description).toBe("mid");
  });

  it("filters by transaction types (multi-select)", async () => {
    const { app } = await makeApp();
    const acc = await createAccount(app);
    await request(app).post("/api/transactions").send({ account_id: acc.id, date: "2025-05-01", description: "spend", amount_fx: 10, exchange_rate: 1, amount_usd: 10, type: "debit" });
    await request(app).post("/api/transactions").send({ account_id: acc.id, date: "2025-05-02", description: "pay", amount_fx: 20, exchange_rate: 1, amount_usd: 20, type: "credit" });

    const credits = await request(app).get("/api/transactions?types=credit");
    expect(credits.body.total).toBe(1);
    expect(credits.body.rows[0].description).toBe("pay");

    const both = await request(app).get("/api/transactions?types=debit,credit");
    expect(both.body.total).toBe(2);
  });

  it("rejects an invalid type in the types filter with 400", async () => {
    const { app } = await makeApp();
    const res = await request(app).get("/api/transactions?types=debit,wizardry");
    expect(res.status).toBe(400);
  });

  it("filters by multiple category ids (category_ids)", async () => {
    const { app } = await makeApp();
    const acc = await createAccount(app);
    const food = (await request(app).post("/api/categories").send({ name: "Food" })).body as { id: number };
    const fuel = (await request(app).post("/api/categories").send({ name: "Fuel" })).body as { id: number };
    const other = (await request(app).post("/api/categories").send({ name: "Other" })).body as { id: number };
    await request(app).post("/api/transactions").send({ account_id: acc.id, category_id: food.id, date: "2025-07-01", description: "food", amount_fx: 1, exchange_rate: 1, amount_usd: 1, type: "debit" });
    await request(app).post("/api/transactions").send({ account_id: acc.id, category_id: fuel.id, date: "2025-07-02", description: "fuel", amount_fx: 1, exchange_rate: 1, amount_usd: 1, type: "debit" });
    await request(app).post("/api/transactions").send({ account_id: acc.id, category_id: other.id, date: "2025-07-03", description: "other", amount_fx: 1, exchange_rate: 1, amount_usd: 1, type: "debit" });

    const res = await request(app).get(`/api/transactions?category_ids=${food.id},${fuel.id}`);
    expect(res.body.total).toBe(2);
    expect(res.body.rows.map((r: { description: string }) => r.description).sort()).toEqual(["food", "fuel"]);
  });

  it("searches by comment, category name, and exact amount", async () => {
    const { app } = await makeApp();
    const acc = await createAccount(app);
    const food = (await request(app).post("/api/categories").send({ name: "Groceries" })).body as { id: number };
    await request(app).post("/api/transactions").send({ account_id: acc.id, category_id: food.id, date: "2025-08-01", description: "Trader Joes", amount_fx: 42.5, exchange_rate: 1, amount_usd: 42.5, type: "debit" });
    await request(app).post("/api/transactions").send({ account_id: acc.id, date: "2025-08-02", description: "Netflix", amount_fx: 15.99, exchange_rate: 1, amount_usd: 15.99, type: "debit" });

    const byComment = await request(app).get("/api/transactions?search=netflix");
    expect(byComment.body.total).toBe(1);
    expect(byComment.body.rows[0].description).toBe("Netflix");

    const byCategory = await request(app).get("/api/transactions?search=grocer");
    expect(byCategory.body.total).toBe(1);
    expect(byCategory.body.rows[0].description).toBe("Trader Joes");

    const byAmount = await request(app).get("/api/transactions?search=15.99");
    expect(byAmount.body.total).toBe(1);
    expect(byAmount.body.rows[0].description).toBe("Netflix");
  });

  it("filters to uncategorized transactions only", async () => {
    const { app } = await makeApp();
    const acc = await createAccount(app);
    const cat = (await request(app).post("/api/categories").send({ name: "Food" })).body as { id: number };
    await request(app).post("/api/transactions").send({ account_id: acc.id, category_id: cat.id, date: "2025-06-01", description: "with-cat", amount_fx: 5, exchange_rate: 1, amount_usd: 5, type: "debit" });
    await request(app).post("/api/transactions").send({ account_id: acc.id, date: "2025-06-02", description: "no-cat", amount_fx: 5, exchange_rate: 1, amount_usd: 5, type: "debit" });

    const uncat = await request(app).get("/api/transactions?uncategorized=1");
    expect(uncat.body.total).toBe(1);
    expect(uncat.body.rows[0].description).toBe("no-cat");
  });
});

describe("balance floating-point integrity", () => {
  it("keeps the running balance free of floating-point drift", async () => {
    const { app } = await makeApp();
    const acc = await createAccount(app, 0);
    await request(app).post("/api/transactions").send({ account_id: acc.id, date: "2026-01-01", description: "", amount_fx: 0.1, exchange_rate: 1, amount_usd: 0.1, type: "credit" });
    await request(app).post("/api/transactions").send({ account_id: acc.id, date: "2026-01-02", description: "", amount_fx: 0.2, exchange_rate: 1, amount_usd: 0.2, type: "credit" });
    expect(await getBalance(app, acc.id)).toBe(0.3); // exact -- not 0.30000000000000004
  });
});

describe("income category enforcement", () => {
  async function createCategory(app: ReturnType<typeof createApp>, kind: "income" | "expense") {
    const res = await request(app).post("/api/categories").send({
      name: kind === "income" ? "Salary" : "Groceries", kind,
    });
    return res.body as { id: number };
  }

  it("rejects a debit transaction on an income category with 400 and no balance change", async () => {
    const { app } = await makeApp();
    const acc = await createAccount(app, 0);
    const cat = await createCategory(app, "income");
    const res = await request(app).post("/api/transactions").send({
      account_id: acc.id, category_id: cat.id, date: "2026-01-01", description: "Paycheck",
      amount_fx: 1000, exchange_rate: 1, amount_usd: 1000, type: "debit",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/income/i);
    expect(await getBalance(app, acc.id)).toBeCloseTo(0);
  });

  it("allows a credit transaction on an income category", async () => {
    const { app } = await makeApp();
    const acc = await createAccount(app, 0);
    const cat = await createCategory(app, "income");
    const res = await request(app).post("/api/transactions").send({
      account_id: acc.id, category_id: cat.id, date: "2026-01-01", description: "Paycheck",
      amount_fx: 1000, exchange_rate: 1, amount_usd: 1000, type: "credit",
    });
    expect(res.status).toBe(201);
    expect(await getBalance(app, acc.id)).toBeCloseTo(1000);
  });

  it("allows a debit transaction on an expense category", async () => {
    const { app } = await makeApp();
    const acc = await createAccount(app, 0);
    const cat = await createCategory(app, "expense");
    const res = await request(app).post("/api/transactions").send({
      account_id: acc.id, category_id: cat.id, date: "2026-01-01", description: "Food",
      amount_fx: 20, exchange_rate: 1, amount_usd: 20, type: "debit",
    });
    expect(res.status).toBe(201);
  });

  it("rejects PATCH that flips an income-category transaction to debit, leaving balance intact", async () => {
    const { app } = await makeApp();
    const acc = await createAccount(app, 0);
    const cat = await createCategory(app, "income");
    const tx = (await request(app).post("/api/transactions").send({
      account_id: acc.id, category_id: cat.id, date: "2026-01-01", description: "Paycheck",
      amount_fx: 1000, exchange_rate: 1, amount_usd: 1000, type: "credit",
    })).body;
    expect(await getBalance(app, acc.id)).toBeCloseTo(1000);

    const res = await request(app).patch(`/api/transactions/${tx.id}`).send({
      account_id: acc.id, category_id: cat.id, date: "2026-01-01", description: "Paycheck",
      amount_fx: 1000, exchange_rate: 1, amount_usd: 1000, type: "debit",
    });
    expect(res.status).toBe(400);
    expect(await getBalance(app, acc.id)).toBeCloseTo(1000);
  });
});
