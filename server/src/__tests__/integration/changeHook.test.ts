import { describe, it, expect, afterEach } from "vitest";
import request from "supertest";
import { createApp } from "../../app.js";
import { createTestDb } from "../../test/db.js";
import { setChangeSink, type LedgerChange } from "../../lib/ledgerHooks.js";

// Change-hook completeness: Balance Desktop's cloud mode feeds its sync
// outbox from these events, so every mutating endpoint must report through
// lib/ledgerHooks.ts. A new mutation path that forgets the hook fails here
// before it silently breaks replica sync.

async function makeApp() {
  const db = await createTestDb();
  return { app: createApp(db), db };
}

const captured: LedgerChange[] = [];

function capture() {
  captured.length = 0;
  setChangeSink((change) => captured.push({ ...change }));
}

afterEach(() => {
  setChangeSink(() => {});
  captured.length = 0;
});

const BASE_ACCOUNT = {
  name: "Hook Checking", account_type: "Checking", liquidity_type: "Liquid",
  base_currency: "USD", balance: 0, exchange_rate: 1, balance_usd: 0,
};

describe("ledger change hook coverage", () => {
  it("rolls ledger writes back when the sync hook cannot persist its outbox record", async () => {
    const { app } = await makeApp();

    setChangeSink(() => { throw new Error("outbox unavailable"); });
    expect((await request(app).post("/api/categories").send({ name: "Must Roll Back" })).status).toBe(500);
    expect((await request(app).post("/api/tags").send({ name: "must-roll-back" })).status).toBe(500);
    expect((await request(app).post("/api/accounts").send(BASE_ACCOUNT)).status).toBe(500);
    expect((await request(app).get("/api/categories")).body).toHaveLength(0);
    expect((await request(app).get("/api/tags")).body).toHaveLength(0);
    expect((await request(app).get("/api/accounts")).body).toHaveLength(0);

    setChangeSink(() => {});
    const account = (await request(app).post("/api/accounts").send(BASE_ACCOUNT)).body;
    const tag = (await request(app).post("/api/tags").send({ name: "existing" })).body;
    const tx = (await request(app).post("/api/transactions").send({
      account_id: account.id, date: "2026-07-01", description: "one",
      amount_fx: 5, exchange_rate: 1, amount_usd: 5, type: "debit",
    })).body;

    setChangeSink(() => { throw new Error("outbox unavailable"); });
    expect((await request(app).put(`/api/tags/transaction/${tx.id}`).send({ tag_ids: [tag.id] })).status).toBe(500);
    expect((await request(app).delete(`/api/accounts/${account.id}`)).status).toBe(500);
    expect((await request(app).get("/api/accounts")).body).toHaveLength(1);

    setChangeSink(() => {});
    const unchanged = (await request(app).get(`/api/transactions/${tx.id}`)).body;
    expect(unchanged.tags ?? []).toHaveLength(0);
  });

  it("reports reset, archive restore, and sample seeding through the hook atomically", async () => {
    const source = await makeApp();
    setChangeSink(() => {});
    await request(source.app).post("/api/accounts").send({ ...BASE_ACCOUNT, balance: 25 });
    const archive = (await request(source.app).get("/api/data/export")).body;

    const restored = await makeApp();
    setChangeSink(() => { throw new Error("outbox unavailable"); });
    expect((await request(restored.app).post("/api/data/import").send(archive)).status).toBe(500);
    expect((await request(restored.app).get("/api/accounts")).body).toHaveLength(0);

    const sampled = await makeApp();
    expect((await request(sampled.app).post("/api/data/sample")).status).toBe(500);
    expect((await request(sampled.app).get("/api/accounts")).body).toHaveLength(0);

    setChangeSink(() => {});
    const account = (await request(restored.app).post("/api/accounts").send(BASE_ACCOUNT)).body;
    setChangeSink(() => { throw new Error("outbox unavailable"); });
    expect((await request(restored.app).post("/api/data/reset").send({ confirm: "Balance" })).status).toBe(500);
    expect((await request(restored.app).get("/api/accounts")).body.map((row: { id: number }) => row.id)).toContain(account.id);
  });

  it("accounts: create (with opening balance), patch, adjust, reorder, delete", async () => {
    const { app } = await makeApp();
    capture();

    const created = (await request(app).post("/api/accounts").send({ ...BASE_ACCOUNT, balance: 100 })).body;
    expect(captured.some((c) => c.entity === "account" && c.op === "upsert")).toBe(true);
    expect(captured.some((c) => c.entity === "account_adjustment" && c.op === "upsert")).toBe(true);

    captured.length = 0;
    await request(app).patch(`/api/accounts/${created.id}`).send({ name: "Renamed" });
    expect(captured.some((c) => c.entity === "account" && c.op === "upsert")).toBe(true);

    captured.length = 0;
    await request(app).patch(`/api/accounts/${created.id}`).send({ balance: 55, reason: "Reconciled" });
    expect(captured.some((c) => c.entity === "account_adjustment")).toBe(true);

    captured.length = 0;
    await request(app).patch("/api/accounts/reorder").send({ order: [{ id: created.id, sort_order: 2 }] });
    expect(captured.some((c) => c.entity === "account" && c.op === "upsert")).toBe(true);

    captured.length = 0;
    await request(app).delete(`/api/accounts/${created.id}`);
    expect(captured.some((c) => c.entity === "account" && c.op === "delete")).toBe(true);
  });

  it("reports every account changed when the default account moves", async () => {
    const { app } = await makeApp();
    setChangeSink(() => {});
    const first = (await request(app).post("/api/accounts").send({ ...BASE_ACCOUNT, name: "First", is_default: true })).body;
    const second = (await request(app).post("/api/accounts").send({ ...BASE_ACCOUNT, name: "Second" })).body;

    capture();
    await request(app).patch(`/api/accounts/${second.id}`).send({ is_default: true });
    expect(captured.filter((change) => change.entity === "account" && change.op === "upsert")).toHaveLength(2);
    expect(new Set(captured.map((change) => change.entityUuid)).size).toBe(2);

    const rows = (await request(app).get("/api/accounts")).body as { id: number; is_default: boolean }[];
    expect(rows.find((row) => row.id === first.id)?.is_default).toBe(false);
    expect(rows.find((row) => row.id === second.id)?.is_default).toBe(true);
  });

  it("transactions: create, patch, delete, transfer, bulk, tag set", async () => {
    const { app } = await makeApp();
    const acc = (await request(app).post("/api/accounts").send(BASE_ACCOUNT)).body;
    const acc2 = (await request(app).post("/api/accounts").send({ ...BASE_ACCOUNT, name: "Second" })).body;
    const tag = (await request(app).post("/api/tags").send({ name: "hook" })).body;
    capture();

    const tx = (await request(app).post("/api/transactions").send({
      account_id: acc.id, date: "2026-07-01", description: "one", amount_fx: 5, exchange_rate: 1, amount_usd: 5, type: "debit",
    })).body;
    expect(captured.filter((c) => c.entity === "transaction" && c.op === "upsert")).toHaveLength(1);

    captured.length = 0;
    await request(app).patch(`/api/transactions/${tx.id}`).send({
      account_id: acc.id, date: "2026-07-01", description: "one!", amount_fx: 6, exchange_rate: 1, type: "debit",
    });
    expect(captured.filter((c) => c.entity === "transaction")).toHaveLength(1);

    captured.length = 0;
    await request(app).post("/api/transactions/transfer").send({
      from_account_id: acc.id, to_account_id: acc2.id, date: "2026-07-02", description: "move", amount_fx: 10,
    });
    expect(captured.filter((c) => c.entity === "transaction" && c.op === "upsert")).toHaveLength(2); // both legs

    captured.length = 0;
    await request(app).post("/api/transactions/bulk").send({
      rows: [
        { account_id: acc.id, date: "2026-07-03", amount_fx: 1, type: "debit" },
        { account_id: acc.id, date: "2026-07-04", amount_fx: 2, type: "credit" },
      ],
    });
    expect(captured.filter((c) => c.entity === "transaction")).toHaveLength(2);

    captured.length = 0;
    await request(app).put(`/api/tags/transaction/${tx.id}`).send({ tag_ids: [tag.id] });
    expect(captured.filter((c) => c.entity === "transaction" && c.op === "upsert")).toHaveLength(1);

    captured.length = 0;
    await request(app).delete(`/api/transactions/${tx.id}`);
    expect(captured.some((c) => c.entity === "transaction" && c.op === "delete")).toBe(true);
  });

  it("categories and tags: create, batch, patch, delete", async () => {
    const { app } = await makeApp();
    capture();

    const cat = (await request(app).post("/api/categories").send({ name: "Food" })).body;
    expect(captured.filter((c) => c.entity === "category" && c.op === "upsert")).toHaveLength(1);

    captured.length = 0;
    await request(app).post("/api/categories/batch").send({ text: "Travel\n  Flights\n  Hotels" });
    expect(captured.filter((c) => c.entity === "category")).toHaveLength(3);

    captured.length = 0;
    await request(app).patch(`/api/categories/${cat.id}`).send({ name: "Food & Drink" });
    expect(captured.filter((c) => c.entity === "category")).toHaveLength(1);

    captured.length = 0;
    await request(app).delete(`/api/categories/${cat.id}`);
    expect(captured.some((c) => c.entity === "category" && c.op === "delete")).toBe(true);

    captured.length = 0;
    const tag = (await request(app).post("/api/tags").send({ name: "t1" })).body;
    expect(captured.some((c) => c.entity === "tag" && c.op === "upsert")).toBe(true);
    captured.length = 0;
    await request(app).delete(`/api/tags/${tag.id}`);
    expect(captured.some((c) => c.entity === "tag" && c.op === "delete")).toBe(true);
  });

  it("every event carries a usable uuid", async () => {
    const { app } = await makeApp();
    capture();
    await request(app).post("/api/accounts").send({ ...BASE_ACCOUNT, balance: 10 });
    expect(captured.length).toBeGreaterThan(0);
    for (const c of captured) {
      expect(c.entityUuid).toMatch(/^[0-9a-f-]{36}$/);
    }
  });
});
