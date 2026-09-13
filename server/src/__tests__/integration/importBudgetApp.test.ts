import { describe, it, expect } from "vitest";
import request from "supertest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "../../app.js";
import { createTestDb } from "../../test/db.js";
import { budgetAppMappingPath } from "../../routes/transactions.js";

const TEST_BUDGET_APP_MAPPING = {
  accounts: {
    "src.testaccount.check": "TestAccount Check",
    "src.testaccount.savings": "TestAccount Savings",
  },
  categoryChildOverrides: {},
};

async function makeApp() {
  const db = await createTestDb();
  return { app: createApp(db, TEST_BUDGET_APP_MAPPING), db };
}

// Minimal valid budget-app CSV with metadata prefix
function budgetAppCsv(rows: string[]): string {
  const header = "date,outcomeAccountName,outcome,incomeAccountName,income,categoryName,comment,payee";
  return `Budget app export\nsome metadata\n${header}\n${rows.join("\n")}`;
}

async function seedAccount(app: ReturnType<typeof createApp>, name: string, baseCurrency = "USD", exchangeRate = 1) {
  return (await request(app).post("/api/accounts").send({
    name, account_type: "Checking", liquidity_type: "Liquid",
    base_currency: baseCurrency, balance: 0, exchange_rate: exchangeRate, balance_usd: 0,
    ticker: null, shares_quantity: null, current_price_usd: null, notes: null,
  })).body;
}

describe("POST /api/transactions/import-budget-app", () => {
  it("resolves the private mapping consistently from desktop and server launches", () => {
    const packageData = resolve(dirname(fileURLToPath(import.meta.url)), "../../../data/budget-app-mapping.json");
    expect(budgetAppMappingPath()).toBe(packageData);
    expect(budgetAppMappingPath("./private/mapping.json")).toBe(resolve("private/mapping.json"));
  });

  it("returns 400 when csv_text missing", async () => {
    const { app } = await makeApp();
    const res = await request(app).post("/api/transactions/import-budget-app").send({});
    expect(res.status).toBe(400);
  });

  it("returns 400 when no budget-app header row found", async () => {
    const { app } = await makeApp();
    const res = await request(app).post("/api/transactions/import-budget-app").send({ csv_text: "no header here\nsome data" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/header/i);
  });

  it("imports debit row and updates account balance", async () => {
    const { app } = await makeApp();
    // Source-app account name → Balance account name (via TEST_BUDGET_APP_MAPPING)
    await seedAccount(app, "TestAccount Check");
    const csv = budgetAppCsv(["2025-01-15,src.testaccount.check,50.00,,,,groceries,Trader Joe"]);
    const res = await request(app).post("/api/transactions/import-budget-app").send({ csv_text: csv });
    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(1);
    expect(res.body.skipped).toBe(0);
    const accounts = (await request(app).get("/api/accounts")).body;
    expect(accounts.find((a: { name: string }) => a.name === "TestAccount Check").balance).toBeCloseTo(-50);
  });

  it("is idempotent -- re-importing same CSV skips all rows", async () => {
    const { app } = await makeApp();
    await seedAccount(app, "TestAccount Check");
    const csv = budgetAppCsv(["2025-01-15,src.testaccount.check,50.00,,,,groceries,Trader Joe"]);
    await request(app).post("/api/transactions/import-budget-app").send({ csv_text: csv });
    const res = await request(app).post("/api/transactions/import-budget-app").send({ csv_text: csv });
    expect(res.body.imported).toBe(0);
    expect(res.body.skipped).toBe(1);
  });

  it("reports unmapped accounts", async () => {
    const { app } = await makeApp();
    const csv = budgetAppCsv(["2025-01-15,UnknownAccount,100,,,,,"]);
    const res = await request(app).post("/api/transactions/import-budget-app").send({ csv_text: csv });
    expect(res.body.imported).toBe(0);
    expect(res.body.unmapped).toContain("account:UnknownAccount");
  });

  it("imports credit row correctly", async () => {
    const { app } = await makeApp();
    await seedAccount(app, "TestAccount Check");
    const csv = budgetAppCsv(["2025-01-15,,,src.testaccount.check,50.00,,salary,"]);
    const res = await request(app).post("/api/transactions/import-budget-app").send({ csv_text: csv });
    expect(res.body.imported).toBe(1);
    const accounts = (await request(app).get("/api/accounts")).body;
    expect(accounts.find((a: { name: string }) => a.name === "TestAccount Check").balance).toBeCloseTo(50);
  });

  it("rejects invalid dates and amounts without partially importing", async () => {
    const { app } = await makeApp();
    await seedAccount(app, "TestAccount Check");
    const csv = budgetAppCsv([
      "2025-01-15,src.testaccount.check,10.00,,,,valid,One",
      "2025-02-31,src.testaccount.check,not-money,,,,invalid,Two",
    ]);
    const res = await request(app).post("/api/transactions/import-budget-app").send({ csv_text: csv });
    expect(res.status).toBe(400);
    expect((await request(app).get("/api/transactions?limit=-1")).body.rows).toHaveLength(0);
  });

  it("deduplicates repeated rows within one imported file", async () => {
    const { app } = await makeApp();
    await seedAccount(app, "TestAccount Check");
    const row = "2025-01-15,src.testaccount.check,50.00,,,,groceries,Trader Joe";
    const res = await request(app).post("/api/transactions/import-budget-app").send({ csv_text: budgetAppCsv([row, row]) });
    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(1);
    expect(res.body.skipped).toBe(1);
  });

  it("keeps different descriptions with the same date and amount", async () => {
    const { app } = await makeApp();
    await seedAccount(app, "TestAccount Check");
    const res = await request(app).post("/api/transactions/import-budget-app").send({ csv_text: budgetAppCsv([
      "2025-01-15,src.testaccount.check,50.00,,,,Merchant One,",
      "2025-01-15,src.testaccount.check,50.00,,,,Merchant Two,",
    ]) });
    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(2);
  });

  it("preserves equal USD value across a cross-currency transfer", async () => {
    const { app } = await makeApp();
    await seedAccount(app, "TestAccount Check", "EUR", 1.2);
    await seedAccount(app, "TestAccount Savings", "USD", 1);
    const csv = budgetAppCsv([
      "2025-01-15,src.testaccount.check,100.00,src.testaccount.savings,120.00,,,Move cash",
    ]);
    const res = await request(app).post("/api/transactions/import-budget-app").send({ csv_text: csv });
    expect(res.status).toBe(200);
    const rows = (await request(app).get("/api/transactions?limit=-1")).body.rows;
    expect(rows).toHaveLength(2);
    expect(rows.map((row: { amount_usd: number }) => row.amount_usd)).toEqual([120, 120]);
  });

  it("rejects a transfer whose two source accounts map to the same Balance account", async () => {
    const { app } = await makeApp();
    await seedAccount(app, "TestAccount Check");
    const csv = budgetAppCsv([
      "2025-01-15,src.testaccount.check,100.00,src.testaccount.check,100.00,,,Move cash",
    ]);
    const res = await request(app).post("/api/transactions/import-budget-app").send({ csv_text: csv });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/different accounts/i);
    expect((await request(app).get("/api/transactions?limit=-1")).body.rows).toHaveLength(0);
  });

  it("reports an unmapped category instead of silently importing it uncategorized", async () => {
    const { app } = await makeApp();
    await seedAccount(app, "TestAccount Check");
    const csv = budgetAppCsv([
      "2025-01-15,src.testaccount.check,50.00,,,Unknown Category,,Trader Joe",
    ]);
    const res = await request(app).post("/api/transactions/import-budget-app").send({ csv_text: csv });
    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(0);
    expect(res.body.unmapped).toContain("category:Unknown Category");
  });

  it("does not import a debit into an income-only category", async () => {
    const { app } = await makeApp();
    await seedAccount(app, "TestAccount Check");
    await request(app).post("/api/categories").send({ name: "Salary", kind: "income" });
    const csv = budgetAppCsv([
      "2025-01-15,src.testaccount.check,50.00,,,Salary,,Employer",
    ]);
    const res = await request(app).post("/api/transactions/import-budget-app").send({ csv_text: csv });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/income category/i);
    expect((await request(app).get("/api/transactions?limit=-1")).body.rows).toHaveLength(0);
  });
});
