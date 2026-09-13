// Accounts shown in the Transactions/Reports account-picker sidebars. Legacy/closed
// accounts (is_active === false) are hidden from the pickers -- they still hold history
// and count toward report totals, they're just not selectable filters. A missing
// is_active is treated as active (back-compat). Mirrors selectableAccounts() in
// TransactionForm, which excludes the same accounts from the new-transaction picker.
export function visibleAccounts<T extends { is_active?: boolean | null }>(accounts: T[]): T[] {
  return accounts.filter((a) => a.is_active !== false);
}
