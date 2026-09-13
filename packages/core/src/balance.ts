// Canonical frozen-delta balance model. The server-side SQL
// recompute (server/src/lib/recompute.ts) must stay equivalent to this: sync
// convergence depends on every replica computing identical balances from
// the same rows. Pinned by the sync-client convergence suite.
//
//   balance(acct) = Σ contribution(tx) + Σ (adj.new_balance − adj.old_balance)
//     contribution: credit → +amount_fx; debit → −amount_fx
//     transfer: 'out' → −amount_fx, 'in' → +amount_fx, null direction → 0
//   balance_usd = round(balance × exchange_rate)
//
// A pure sum is fully order-independent: any two replicas holding the same
// rows show identical balances, regardless of the order edits arrived in.

import { isStorableCents, type TransactionType, type TransferDirection } from "./finance";

export interface BalanceTxRow {
  type: TransactionType;
  amount_fx: number; // cents
  transfer_direction: TransferDirection | null;
}

export interface BalanceAdjRow {
  old_balance: number; // cents
  new_balance: number; // cents
}

// Signed cents contribution of one transaction row to its account's balance.
// A transfer leg without a direction contributes 0, matching the historical
// lone-leg behavior for rows that predate the transfer_direction column.
export function contribution(tx: BalanceTxRow): number {
  if (tx.type === "credit") return tx.amount_fx;
  if (tx.type === "debit") return -tx.amount_fx;
  if (tx.transfer_direction === "out") return -tx.amount_fx;
  if (tx.transfer_direction === "in") return tx.amount_fx;
  return 0;
}

// Native-currency balance in cents. Integer sum over integers -- exact.
export function computeBalance(txs: BalanceTxRow[], adjs: BalanceAdjRow[]): number {
  // Sum in BigInt so an adversarial but ultimately cancelling set cannot lose
  // integer precision before the final range check. This also keeps validation
  // independent of row order, which is required for replica convergence.
  let total = 0n;
  for (const tx of txs) {
    if (!isStorableCents(tx.amount_fx)) throw new RangeError("transaction amount is outside the supported money range");
    total += BigInt(contribution(tx));
  }
  for (const adj of adjs) {
    if (!isStorableCents(adj.old_balance) || !isStorableCents(adj.new_balance)) {
      throw new RangeError("account adjustment is outside the supported money range");
    }
    total += BigInt(adj.new_balance) - BigInt(adj.old_balance);
  }
  const result = Number(total);
  if (!isStorableCents(result)) throw new RangeError("account balance is outside the supported money range");
  return result;
}

// USD-equivalent cents. Rounded once, at the end, from the exact cents sum.
export function computeBalanceUsd(balanceCents: number, exchangeRate: number): number {
  if (!isStorableCents(balanceCents) || !Number.isFinite(exchangeRate) || exchangeRate <= 0) {
    throw new RangeError("account balance conversion is outside the supported money range");
  }
  const result = Math.round(balanceCents * exchangeRate);
  if (!isStorableCents(result)) throw new RangeError("account balance conversion is outside the supported money range");
  return result;
}
