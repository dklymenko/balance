import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import request from "supertest";
import { exportLegacyDb } from "../../tools/exportLegacyDb.js";
import { createApp } from "../../app.js";
import { createTestDb } from "../../test/db.js";

// Builds a database in the legacy (pre-cents) layout -- dollar REALs, integer
// booleans, no migration journal -- and verifies the exporter produces an
// archive the current importer accepts, with money correctly ×100.

function makeLegacyDb(path: string) {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE accounts (
      id integer PRIMARY KEY AUTOINCREMENT, name text NOT NULL,
      account_type text NOT NULL, base_currency text NOT NULL DEFAULT 'USD',
      liquidity_type text NOT NULL, balance real NOT NULL DEFAULT 0,
      exchange_rate real NOT NULL DEFAULT 1, balance_usd real NOT NULL DEFAULT 0,
      ticker text, shares_quantity real, current_price_usd real,
      sort_order integer, notes text, is_default integer NOT NULL DEFAULT 0,
      is_active integer NOT NULL DEFAULT 1,
      created_at text NOT NULL DEFAULT '2025-01-01T00:00:00.000Z',
      updated_at text NOT NULL DEFAULT '2025-01-01T00:00:00.000Z'
    );
    CREATE TABLE categories (
      id integer PRIMARY KEY AUTOINCREMENT, name text NOT NULL,
      parent_id integer, kind text NOT NULL DEFAULT 'expense',
      created_at text NOT NULL DEFAULT '2025-01-01T00:00:00.000Z'
    );
    CREATE TABLE tags (
      id integer PRIMARY KEY AUTOINCREMENT, name text NOT NULL UNIQUE,
      created_at text NOT NULL DEFAULT '2025-01-01T00:00:00.000Z'
    );
    CREATE TABLE transactions (
      id integer PRIMARY KEY AUTOINCREMENT, account_id integer NOT NULL,
      category_id integer, date text NOT NULL, description text NOT NULL DEFAULT '',
      amount_fx real NOT NULL, exchange_rate real NOT NULL DEFAULT 1,
      amount_usd real NOT NULL, type text NOT NULL,
      exclude_from_reports integer NOT NULL DEFAULT 0,
      created_at text NOT NULL DEFAULT '2025-01-01T00:00:00.000Z',
      updated_at text NOT NULL DEFAULT '2025-01-01T00:00:00.000Z'
    );
    CREATE TABLE account_adjustments (
      id integer PRIMARY KEY AUTOINCREMENT, account_id integer NOT NULL,
      old_balance real NOT NULL, new_balance real NOT NULL, reason text NOT NULL,
      created_at text NOT NULL DEFAULT '2025-01-01T00:00:00.000Z'
    );
    CREATE TABLE transaction_tags (
      transaction_id integer NOT NULL, tag_id integer NOT NULL,
      PRIMARY KEY (transaction_id, tag_id)
    );
  `);
  db.prepare(`INSERT INTO accounts (name, account_type, liquidity_type, balance, balance_usd, is_default) VALUES
    ('Checking', 'Checking', 'Liquid', 123.45, 123.45, 1)`).run();
  db.prepare(`INSERT INTO categories (name, kind) VALUES ('Food', 'expense')`).run();
  db.prepare(`INSERT INTO tags (name) VALUES ('trip')`).run();
  db.prepare(`INSERT INTO transactions (account_id, category_id, date, description, amount_fx, amount_usd, type, exclude_from_reports)
    VALUES (1, 1, '2026-01-05', 'lunch', 12.5, 12.5, 'debit', 0)`).run();
  db.prepare(`INSERT INTO account_adjustments (account_id, old_balance, new_balance, reason)
    VALUES (1, 0, 123.45, 'initial')`).run();
  db.prepare(`INSERT INTO transaction_tags VALUES (1, 1)`).run();
  db.close();
}

describe("exportLegacyDb", () => {
  it("converts a dollar-float legacy DB into an importable cents archive", async () => {
    const dir = mkdtempSync(join(tmpdir(), "balance-legacy-"));
    try {
      const path = join(dir, "old.db");
      makeLegacyDb(path);

      const archive = exportLegacyDb(path);
      expect(archive.format).toBe("balance-archive");
      expect(archive.version).toBe(1);
      const accounts = archive.accounts as Record<string, unknown>[];
      expect(accounts[0].balance).toBe(12345); // dollars -> integer cents
      expect(accounts[0].is_default).toBe(true); // 1 -> boolean
      const txs = archive.transactions as Record<string, unknown>[];
      expect(txs[0].amount_usd).toBe(1250);
      expect(txs[0].exclude_from_reports).toBe(false);

      // The current importer accepts it end to end.
      const app = createApp(createTestDb());
      const res = await request(app).post("/api/data/import").send(archive);
      expect(res.status).toBe(201);
      expect(res.body.counts.transactions).toBe(1);
      const me = await request(app).get("/api/accounts");
      expect(me.body[0].balance).toBeCloseTo(123.45); // dollars at the API again
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a current-format (migration-managed) database", () => {
    const dir = mkdtempSync(join(tmpdir(), "balance-legacy-"));
    try {
      const path = join(dir, "new.db");
      const db = new Database(path);
      db.exec("CREATE TABLE __drizzle_migrations (id integer primary key)");
      db.close();
      expect(() => exportLegacyDb(path)).toThrow(/migration-managed/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
