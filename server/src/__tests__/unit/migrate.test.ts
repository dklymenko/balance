import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../../db/schema.js";
import { runMigrations } from "../../db/migrate.js";

// Boot-time migration runner for the embedded (Balance Desktop) mode: a fresh
// DB file must come up with the full schema, and running again must be a no-op.

describe("runMigrations", () => {
  it("applies the bundled migrations to a fresh database", () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite, { schema });
    runMigrations(db);

    const tables = (sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[])
      .map((r) => r.name);
    for (const t of ["accounts", "categories", "tags", "transactions", "transaction_tags", "account_adjustments", "amazon_orders"]) {
      expect(tables).toContain(t);
    }
  });

  it("is idempotent", () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite, { schema });
    runMigrations(db);
    expect(() => runMigrations(db)).not.toThrow();
  });
});
