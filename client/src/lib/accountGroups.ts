// Single source of truth for how accounts are grouped in the UI. The DB keeps one
// "Liquid" liquidity_type; the UI splits it into Banking and Credit. Previously
// this same config was copy-pasted in Accounts, AccountFilter, TransactionForm,
// and MultiTransactionForm -- change it once here now.
//
// The filter takes a structural shape so any account-like object works (the page
// models carry more fields; only these two are needed to group).
export interface GroupableAccount {
  liquidity_type: string;
  account_type: string;
}

export type AccountGroupKey = "Credit" | "Banking" | "Invested" | "Locked";

export const ACCOUNT_GROUPS: {
  key: AccountGroupKey;
  label: string;
  filter: (a: GroupableAccount) => boolean;
}[] = [
  { key: "Credit",   label: "Credit",   filter: (a) => a.liquidity_type === "Liquid" && a.account_type === "CC" },
  { key: "Banking",  label: "Banking",  filter: (a) => a.liquidity_type === "Liquid" && a.account_type !== "CC" },
  { key: "Invested", label: "Invested", filter: (a) => a.liquidity_type === "Invested" },
  { key: "Locked",   label: "Locked",   filter: (a) => a.liquidity_type === "Locked" },
];
