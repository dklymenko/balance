import { sql } from "drizzle-orm";
import type { DrizzleDB } from "./types.js";

// One better-sqlite3 connection cannot host overlapping BEGIN/COMMIT scopes.
// Route handlers are async, so a future awaited operation (or a slow hook) can
// otherwise let a second request begin inside the first transaction. Keep a
// per-connection FIFO without coupling independent test/application databases.
const transactionTails = new WeakMap<object, Promise<void>>();

// better-sqlite3 is a synchronous driver, so drizzle's db.transaction()
// requires a synchronous callback, while route code is written await-style.
// This helper wraps BEGIN/COMMIT around the async body instead. Every awaited
// statement still executes synchronously inside better-sqlite3 before its
// promise resolves, while the per-connection FIFO above prevents another
// request from entering an overlapping transaction. It is intentionally
// non-reentrant: callers must not nest runTransaction on the same connection.
export async function runTransaction<T>(
  db: DrizzleDB,
  fn: (tx: DrizzleDB) => Promise<T>,
): Promise<T> {
  const previous = transactionTails.get(db as object) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  transactionTails.set(db as object, previous.then(() => gate, () => gate));
  await previous.catch(() => undefined);

  let began = false;
  try {
    db.run(sql`begin immediate`);
    began = true;
    const result = await fn(db);
    db.run(sql`commit`);
    began = false;
    return result;
  } catch (err) {
    if (began) db.run(sql`rollback`);
    throw err;
  } finally {
    release();
  }
}
