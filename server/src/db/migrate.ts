import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import type { DrizzleDB } from "./types.js";

// Programmatic migration runner: every run mode migrates its database file on
// boot before
// listen. The migrations folder ships inside the package (src/migrations is
// included in the npm files list), so resolve it relative to this module:
// dist/db/migrate.js -> ../../src/migrations.
const MIGRATIONS_DIR = join(fileURLToPath(import.meta.url), "../../../src/migrations");

export function runMigrations(db: DrizzleDB): void {
  // Legacy guard: a database from the pre-cents version (dollar floats,
  // push-managed, no migration journal) cannot be migrated in place.
  const [hasAccounts] = db.all<{ n: number }>(
    sql`select count(*) as n from sqlite_master where type = 'table' and name = 'accounts'`,
  );
  const [hasJournal] = db.all<{ n: number }>(
    sql`select count(*) as n from sqlite_master where type = 'table' and name = '__drizzle_migrations'`,
  );
  if (hasAccounts.n > 0 && hasJournal.n === 0) {
    throw new Error(
      "This database was created by an older Balance (dollar-float storage). " +
      "To migrate: run the old version, download a Balance archive (GET /api/data/export), " +
      "move this database file aside, boot fresh, and import the archive (POST /api/data/import).",
    );
  }
  migrate(db, { migrationsFolder: MIGRATIONS_DIR });
}
