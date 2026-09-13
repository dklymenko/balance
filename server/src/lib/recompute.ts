import { eq, sql } from "drizzle-orm";
import { accounts, accountAdjustments, transactions } from "../db/schema.js";
import type { DrizzleDB } from "../db/types.js";
import { assertStorableCents } from "./finance.js";

// Canonical frozen-delta balance recompute:
//
//   balance = SUM contribution(tx) + SUM (adj.new_balance - adj.old_balance)
//     credit -> +amount_fx; debit -> -amount_fx
//     transfer 'out' -> -amount_fx; 'in' -> +amount_fx; NULL direction -> 0
//   balance_usd = round(balance * exchange_rate)
//
// A pure sum is order-independent, which lets replicas converge on identical
// balances from the same rows. All balance writes flow through here.

export function recomputeAccountBalance(db: DrizzleDB, accountId: number): void {
  const [acct] = db
    .select({ exchange_rate: accounts.exchange_rate })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .all();
  if (!acct) return; // deleted concurrently -- nothing to write

  const [txSum] = db
    .select({
      c: sql<number>`COALESCE(SUM(CASE
        WHEN ${transactions.type} = 'credit' THEN ${transactions.amount_fx}
        WHEN ${transactions.type} = 'debit' THEN -${transactions.amount_fx}
        WHEN ${transactions.transfer_direction} = 'out' THEN -${transactions.amount_fx}
        WHEN ${transactions.transfer_direction} = 'in' THEN ${transactions.amount_fx}
        ELSE 0 END), 0)`,
    })
    .from(transactions)
    .where(eq(transactions.account_id, accountId))
    .all();

  const [adjSum] = db
    .select({
      c: sql<number>`COALESCE(SUM(${accountAdjustments.new_balance} - ${accountAdjustments.old_balance}), 0)`,
    })
    .from(accountAdjustments)
    .where(eq(accountAdjustments.account_id, accountId))
    .all();

  // This is the single writer of both balance columns, so it is also the one
  // place that can refuse a ledger whose totals no longer fit exact integer
  // cents. Throwing rolls the enclosing transaction back, which leaves the
  // stored balance untouched rather than replacing it with a float.
  const balance = assertStorableCents(Number(txSum.c) + Number(adjSum.c), "account balance");
  const balanceUsd = assertStorableCents(
    Math.round(balance * acct.exchange_rate),
    "account balance x exchange_rate",
  );
  db.update(accounts)
    .set({ balance, balance_usd: balanceUsd })
    .where(eq(accounts.id, accountId))
    .run();
}

// Bulk paths fold to one recompute per touched account.
export function recomputeAccounts(db: DrizzleDB, accountIds: Iterable<number>): void {
  for (const id of new Set(accountIds)) recomputeAccountBalance(db, id);
}
