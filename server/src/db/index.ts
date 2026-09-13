import { createRequire } from "node:module";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";
import "dotenv/config";

// Driver injection: Balance Desktop's encrypted mode swaps in
// better-sqlite3-multiple-ciphers (SQLCipher-compatible, API-identical) and
// supplies a raw key; ordinary local server/test runs use stock better-sqlite3.
// Resolved with require() so the optional encrypted driver is only loaded
// when configured.
const require = createRequire(import.meta.url);
const driverName = process.env.BALANCE_SQLITE_DRIVER ?? "better-sqlite3";
const Database = require(driverName) as typeof import("better-sqlite3");

const dbUrl = process.env.DATABASE_URL ?? "./data/balance.db";

export const sqlite = new Database(dbUrl);

// SQLCipher: the key pragma must be the FIRST statement on the connection.
// Raw-key form (64 hex chars = 32 bytes) skips the passphrase KDF, so the
// shell owns key derivation/wrapping (Keychain / App Lock) entirely.
const dbKey = process.env.BALANCE_DB_KEY;
if (dbKey) {
  if (!/^[0-9a-fA-F]{64}$/.test(dbKey)) {
    throw new Error("BALANCE_DB_KEY must be 64 hex characters (a 32-byte raw key)");
  }
  sqlite.pragma(`key="x'${dbKey}'"`);
}

sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

export const db = drizzle(sqlite, { schema });
