// All balance writes flow through recomputeAccountBalance(). Incremental
// deltas are deliberately avoided: balance is a pure
// function of replicated state, so any two replicas holding the same rows
// show identical balances.
import { eq } from "drizzle-orm";
import { accounts, accountAdjustments, transactions } from "./schema.js";
import type { DbExecutor } from "./types.js";
import { computeBalance, computeBalanceUsd } from "@balance/core";

export function recomputeAccountBalance(exec: DbExecutor, accountId: number): void {
  const acct = exec
    .select({ exchange_rate: accounts.exchange_rate })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .get();
  if (!acct) return; // deleted concurrently -- nothing to write

  const txs = exec
    .select({
      type: transactions.type,
      amount_fx: transactions.amount_fx,
      transfer_direction: transactions.transfer_direction,
    })
    .from(transactions)
    .where(eq(transactions.account_id, accountId))
    .all();
  const adjs = exec
    .select({
      old_balance: accountAdjustments.old_balance,
      new_balance: accountAdjustments.new_balance,
    })
    .from(accountAdjustments)
    .where(eq(accountAdjustments.account_id, accountId))
    .all();

  const balance = computeBalance(txs, adjs);
  exec
    .update(accounts)
    .set({ balance, balance_usd: computeBalanceUsd(balance, acct.exchange_rate) })
    .where(eq(accounts.id, accountId))
    .run();
}

// Bulk paths fold to one recompute per touched account.
export function recomputeAccounts(exec: DbExecutor, accountIds: Iterable<number>): void {
  for (const id of new Set(accountIds)) recomputeAccountBalance(exec, id);
}

export function recomputeAllAccounts(exec: DbExecutor): void {
  const rows = exec.select({ id: accounts.id }).from(accounts).all();
  for (const row of rows) recomputeAccountBalance(exec, row.id);
}
