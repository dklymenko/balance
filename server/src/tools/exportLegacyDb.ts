// One-shot exporter for legacy (pre-cents) Balance databases.
//
// Databases created before the integer-cents storage reset hold dollars in
// REAL columns and have no migration journal, so the current server refuses
// to open them (see db/migrate.ts). This tool reads such a file directly and
// writes a Balance archive v1 (integer cents) that POST /api/data/import
// accepts into a fresh database:
//
//   npm run build --workspace=server
//   node server/dist/tools/exportLegacyDb.js /path/to/old-balance.db > archive.json
//   # boot the new server against a fresh DB, then:
//   curl -X POST http://localhost:3001/api/data/import \
//     -H "Content-Type: application/json" --data-binary @archive.json

import Database from "better-sqlite3";

type Row = Record<string, unknown>;

const toCents = (v: unknown): number => Math.round(Number(v ?? 0) * 100);
const toBool = (v: unknown): boolean => v === 1 || v === true;

function tableRows(db: Database.Database, name: string): Row[] {
  const exists = db
    .prepare("select count(*) as n from sqlite_master where type = 'table' and name = ?")
    .get(name) as { n: number };
  if (!exists.n) return [];
  return db.prepare(`select * from "${name}" order by rowid`).all() as Row[];
}

export function exportLegacyDb(path: string): Record<string, unknown> {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const journal = db
      .prepare("select count(*) as n from sqlite_master where name = '__drizzle_migrations'")
      .get() as { n: number };
    if (journal.n > 0) {
      throw new Error("This database is already migration-managed (current format) -- export it with GET /api/data/export instead.");
    }

    return {
      format: "balance-archive",
      version: 1,
      exported_at: new Date().toISOString(),
      accounts: tableRows(db, "accounts").map((a) => ({
        ...a,
        balance: toCents(a.balance),
        balance_usd: toCents(a.balance_usd),
        current_price_usd: a.current_price_usd == null ? null : toCents(a.current_price_usd),
        is_default: toBool(a.is_default),
        is_active: a.is_active == null ? true : toBool(a.is_active),
      })),
      categories: tableRows(db, "categories").map((c) => ({
        ...c,
        kind: c.kind ?? "expense",
      })),
      tags: tableRows(db, "tags"),
      transactions: tableRows(db, "transactions").map((t) => ({
        ...t,
        amount_fx: toCents(t.amount_fx),
        amount_usd: toCents(t.amount_usd),
        exclude_from_reports: toBool(t.exclude_from_reports),
      })),
      account_adjustments: tableRows(db, "account_adjustments").map((a) => ({
        ...a,
        old_balance: toCents(a.old_balance),
        new_balance: toCents(a.new_balance),
      })),
      transaction_tags: tableRows(db, "transaction_tags"),
    };
  } finally {
    db.close();
  }
}

// CLI entry: node exportLegacyDb.js <old.db>
const invokedDirectly = process.argv[1]?.endsWith("exportLegacyDb.js");
if (invokedDirectly) {
  const path = process.argv[2];
  if (!path) {
    console.error("Usage: node exportLegacyDb.js /path/to/old-balance.db > archive.json");
    process.exit(2);
  }
  process.stdout.write(JSON.stringify(exportLegacyDb(path), null, 1) + "\n");
}
