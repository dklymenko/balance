import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";

// Migration 0001 is data surgery on live ledgers (uuid backfill, transfer
// directions from id order, drift-freezing synthetic adjustments) -- pin its
// behavior against legacy-shaped rows before it ever touches a real
// balance.db.

const migrationsDir = join(fileURLToPath(import.meta.url), "../../../../src/migrations");

function migrationFiles(): string[] {
  return readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
}

function setupLegacyDb(): Database.Database {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  // Apply everything before 0001, seed legacy rows, then apply 0001.
  for (const file of migrationFiles().filter((f) => !f.startsWith("0001"))) {
    sqlite.exec(readFileSync(join(migrationsDir, file), "utf-8"));
  }
  sqlite.exec(`
    INSERT INTO accounts (name, account_type, liquidity_type, balance, exchange_rate, balance_usd)
      VALUES ('Checking', 'Checking', 'Liquid', 50000, 1, 50000),
             ('Savings',  'Savings',  'Liquid', 20000, 1, 20000),
             ('Clean',    'Cash',     'Liquid', -700,  1, -700);
    INSERT INTO transactions (account_id, date, amount_fx, exchange_rate, amount_usd, type)
      VALUES (1, '2026-06-01', 2500, 1, 2500, 'debit'),
             (3, '2026-06-02', 700,  1, 700,  'debit');
    INSERT INTO transactions (account_id, date, amount_fx, exchange_rate, amount_usd, type, transfer_group_id)
      VALUES (1, '2026-06-10', 10000, 1, 10000, 'transfer', 'group-1'),
             (2, '2026-06-10', 10000, 1, 10000, 'transfer', 'group-1'),
             (2, '2026-06-12', 500,   1, 500,   'transfer', 'group-lone');
  `);
  sqlite.exec(readFileSync(join(migrationsDir, migrationFiles().find((f) => f.startsWith("0001"))!), "utf-8"));
  return sqlite;
}

function canonical(sqlite: Database.Database, accountId: number): number {
  const row = sqlite.prepare(`
    SELECT COALESCE((SELECT SUM(CASE
        WHEN t.type='credit' THEN t.amount_fx
        WHEN t.type='debit' THEN -t.amount_fx
        WHEN t.transfer_direction='out' THEN -t.amount_fx
        WHEN t.transfer_direction='in' THEN t.amount_fx
        ELSE 0 END) FROM transactions t WHERE t.account_id=?),0)
     + COALESCE((SELECT SUM(j.new_balance - j.old_balance)
        FROM account_adjustments j WHERE j.account_id=?),0) AS c`).get(accountId, accountId) as { c: number };
  return Number(row.c);
}

describe("0001 sync migration backfills", () => {
  it("stamps every row with a unique uuid", () => {
    const sqlite = setupLegacyDb();
    for (const table of ["accounts", "categories", "tags", "transactions", "account_adjustments"]) {
      const bad = sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE uuid = '' OR uuid IS NULL`).get() as { n: number };
      expect(bad.n).toBe(0);
      const dup = sqlite.prepare(`SELECT COUNT(*) AS n FROM (SELECT uuid FROM ${table} GROUP BY uuid HAVING COUNT(*) > 1)`).get() as { n: number };
      expect(dup.n).toBe(0);
    }
    const sample = sqlite.prepare("SELECT uuid FROM accounts LIMIT 1").get() as { uuid: string };
    expect(sample.uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("assigns transfer directions by id order and leaves lone legs NULL", () => {
    const sqlite = setupLegacyDb();
    const legs = sqlite.prepare(
      "SELECT id, transfer_direction, transfer_group_id FROM transactions WHERE type='transfer' ORDER BY id",
    ).all() as { id: number; transfer_direction: string | null; transfer_group_id: string }[];
    const pair = legs.filter((l) => l.transfer_group_id === "group-1");
    expect(pair[0].transfer_direction).toBe("out"); // lower id
    expect(pair[1].transfer_direction).toBe("in");
    expect(legs.find((l) => l.transfer_group_id === "group-lone")!.transfer_direction).toBeNull();
  });

  it("freezes synthetic opening-balance adjustments so recompute preserves every stored balance exactly", () => {
    const sqlite = setupLegacyDb();
    const stored = sqlite.prepare("SELECT id, name, balance FROM accounts").all() as { id: number; name: string; balance: number }[];
    for (const acc of stored) {
      expect(canonical(sqlite, acc.id)).toBe(acc.balance);
    }
    const adjustments = sqlite.prepare(
      "SELECT account_id, old_balance, new_balance, reason FROM account_adjustments ORDER BY account_id",
    ).all() as { account_id: number; old_balance: number; new_balance: number; reason: string }[];
    // Checking: contributions were -2500 -10000 = -12500; delta lands it at 50000.
    const checking = adjustments.find((a) => a.account_id === 1)!;
    expect(checking.old_balance).toBe(-12500);
    expect(checking.new_balance).toBe(50000);
    expect(checking.reason).toBe("Opening balance (sync migration)");
    // Savings drifted too (in-leg 10000 vs stored 20000); Clean already matches.
    expect(adjustments.some((a) => a.account_id === 2)).toBe(true);
    expect(adjustments.some((a) => a.account_id === 3)).toBe(false);
  });
});
