import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../app.js";
import { createTestDb } from "../../test/db.js";

async function makeApp() {
  const db = await createTestDb();
  return createApp(db);
}

const account = {
  name: "Synthetic Checking", account_type: "Checking", liquidity_type: "Liquid",
  base_currency: "USD", balance: 0, exchange_rate: 1,
};

describe("write API input validation", () => {
  it("returns 400 for malformed account payloads and reorder requests", async () => {
    const app = await makeApp();
    expect((await request(app).post("/api/accounts").send({})).status).toBe(400);
    expect((await request(app).post("/api/accounts").send({ ...account, account_type: "Crypto" })).status).toBe(400);
    expect((await request(app).patch("/api/accounts/reorder").send({ order: "all" })).status).toBe(400);
    const created = (await request(app).post("/api/accounts").send(account)).body;
    expect((await request(app).patch("/api/accounts/reorder").send({ order: [
      { id: created.id, sort_order: 1 }, { id: created.id, sort_order: 2 },
    ] })).status).toBe(400);
    expect((await request(app).patch("/api/accounts/reorder").send({ order: [
      { id: 999_999, sort_order: 1 },
    ] })).status).toBe(400);
  });

  it("enforces a two-level, acyclic category tree", async () => {
    const app = await makeApp();
    expect((await request(app).post("/api/categories").send({ name: "" })).status).toBe(400);
    expect((await request(app).post("/api/categories").send({ name: "Bad", kind: "unknown" })).status).toBe(400);
    const parent = (await request(app).post("/api/categories").send({ name: "Parent" })).body;
    const child = (await request(app).post("/api/categories").send({ name: "Child", parent_id: parent.id })).body;
    const otherParent = (await request(app).post("/api/categories").send({ name: "Other parent" })).body;
    expect((await request(app).post("/api/categories").send({ name: "Grandchild", parent_id: child.id })).status).toBe(400);
    expect((await request(app).patch(`/api/categories/${parent.id}`).send({ parent_id: parent.id })).status).toBe(400);
    expect((await request(app).patch(`/api/categories/${parent.id}`).send({ parent_id: otherParent.id })).status).toBe(400);
  });

  it("does not allow concurrent parent changes to create a category cycle", async () => {
    const app = await makeApp();
    const a = (await request(app).post("/api/categories").send({ name: "A" })).body;
    const b = (await request(app).post("/api/categories").send({ name: "B" })).body;
    const responses = await Promise.all([
      request(app).patch(`/api/categories/${a.id}`).send({ parent_id: b.id }),
      request(app).patch(`/api/categories/${b.id}`).send({ parent_id: a.id }),
    ]);
    expect(responses.filter((response) => response.status === 200)).toHaveLength(1);
    expect(responses.filter((response) => response.status === 400)).toHaveLength(1);

    const rows = (await request(app).get("/api/categories")).body as Array<{ id: number; parent_id: number | null }>;
    const byId = new Map(rows.map((row) => [row.id, row]));
    for (const row of rows) {
      if (row.parent_id !== null) expect(byId.get(row.parent_id)?.parent_id).toBeNull();
    }
  });

  it("rejects empty tags and malformed tag assignments", async () => {
    const app = await makeApp();
    expect((await request(app).post("/api/tags").send({ name: "  " })).status).toBe(400);
    expect((await request(app).post("/api/tags").send({ name: "reviewed" })).status).toBe(201);
    const duplicate = await request(app).post("/api/tags").send({ name: " reviewed " });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error).toMatch(/already exists/i);
    expect((await request(app).put("/api/tags/transaction/1").send({ tag_ids: "1,2" })).status).toBe(400);
    expect((await request(app).put("/api/tags/transaction/999999").send({ tag_ids: [] })).status).toBe(404);

    const createdAccount = (await request(app).post("/api/accounts").send(account)).body;
    const createdTransaction = (await request(app).post("/api/transactions").send({
      account_id: createdAccount.id,
      category_id: null,
      date: "2026-08-23",
      description: "Synthetic",
      amount_fx: 10,
      exchange_rate: 1,
      type: "debit",
    })).body;
    expect((await request(app).put(`/api/tags/transaction/${createdTransaction.id}`).send({
      tag_ids: [999999],
    })).status).toBe(400);

    const racedTag = (await request(app).post("/api/tags").send({ name: "race" })).body;
    const [assignment, deletion] = await Promise.all([
      request(app).put(`/api/tags/transaction/${createdTransaction.id}`).send({ tag_ids: [racedTag.id] }),
      request(app).delete(`/api/tags/${racedTag.id}`),
    ]);
    expect(deletion.status).toBe(204);
    expect([200, 400]).toContain(assignment.status);
  });

  it("rejects invalid transaction amounts, rates, and dates", async () => {
    const app = await makeApp();
    const created = (await request(app).post("/api/accounts").send(account)).body;
    const base = {
      account_id: created.id, category_id: null, date: "2026-08-23",
      description: "Synthetic", amount_fx: 10, exchange_rate: 1, type: "debit",
    };
    expect((await request(app).post("/api/transactions").send({ ...base, amount_fx: 0 })).status).toBe(400);
    expect((await request(app).post("/api/transactions").send({ ...base, amount_fx: null })).status).toBe(400);
    expect((await request(app).post("/api/transactions").send({ ...base, exchange_rate: -1 })).status).toBe(400);
    expect((await request(app).post("/api/transactions").send({ ...base, date: "2026-99-99" })).status).toBe(400);
    expect((await request(app).post("/api/transactions/transfer").send({
      from_account_id: created.id, to_account_id: created.id + 1,
      date: "tomorrow", description: "Synthetic", amount_fx: 10,
    })).status).toBe(400);
  });

  it("rejects malformed resource ids consistently", async () => {
    const app = await makeApp();
    const cases: Array<["get" | "patch" | "delete" | "put", string, unknown?]> = [
      ["get", "/api/accounts/not-a-number/verify"],
      ["patch", "/api/accounts/1.5", {}],
      ["delete", "/api/accounts/-1"],
      ["patch", "/api/categories/nope", {}],
      ["delete", "/api/categories/0"],
      ["delete", "/api/tags/nope"],
      ["put", "/api/tags/transaction/1.5", { tag_ids: [] }],
      ["patch", "/api/transactions/nope", {}],
      ["delete", "/api/transactions/0"],
    ];
    for (const [method, url, body] of cases) {
      const response = await request(app)[method](url).send(body);
      expect(response.status, `${method.toUpperCase()} ${url}`).toBe(400);
    }
  });
});
