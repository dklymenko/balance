import { describe, it, expect } from "vitest";
import request from "supertest";
import { createApp } from "../../app.js";
import { createTestDb } from "../../test/db.js";

// updated_at used to be written only by the insert default (Architecture
// Audit §11: "frozen and misleading"). Every PATCH must now advance it.

async function makeApp() {
  const db = await createTestDb();
  return { app: createApp(db), db };
}

// created_at and updated_at are millisecond-precision ISO strings. Against an
// in-memory database a POST and the PATCH that follows it can land inside the
// same millisecond, which fails a strict comparison for a reason that has
// nothing to do with the behaviour under test. Waiting past the boundary keeps
// "advances" a strict assertion instead of weakening it to "does not go
// backwards", which would no longer catch a frozen updated_at.
const passMillisecondBoundary = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("updated_at maintenance", () => {
  it("PATCH /api/accounts/:id advances updated_at", async () => {
    const { app } = await makeApp();
    const acc = (await request(app).post("/api/accounts").send({
      name: "Checking", account_type: "Checking", liquidity_type: "Liquid",
      base_currency: "USD", balance: 0, exchange_rate: 1, balance_usd: 0,
    })).body as { id: number; created_at: string; updated_at: string };
    expect(acc.updated_at).toBe(acc.created_at); // insert default

    await passMillisecondBoundary();
    const patched = (await request(app).patch(`/api/accounts/${acc.id}`)
      .send({ name: "Renamed" })).body as { updated_at: string };
    expect(patched.updated_at > acc.created_at).toBe(true);
  });

  it("PATCH /api/transactions/:id advances updated_at", async () => {
    const { app } = await makeApp();
    const acc = (await request(app).post("/api/accounts").send({
      name: "Checking", account_type: "Checking", liquidity_type: "Liquid",
      base_currency: "USD", balance: 0, exchange_rate: 1, balance_usd: 0,
    })).body as { id: number };
    const tx = (await request(app).post("/api/transactions").send({
      account_id: acc.id, date: "2025-06-01", description: "x",
      amount_fx: 10, exchange_rate: 1, amount_usd: 10, type: "debit",
    })).body as { id: number; created_at: string };

    await passMillisecondBoundary();
    const patched = (await request(app).patch(`/api/transactions/${tx.id}`).send({
      account_id: acc.id, date: "2025-06-01", description: "y",
      amount_fx: 10, exchange_rate: 1, amount_usd: 10, type: "debit",
      exclude_from_reports: false,
    })).body as { updated_at: string };
    expect(patched.updated_at > tx.created_at).toBe(true);
  });
});
