// Human-readable labels for the raw account-type enum, so internal-looking
// values ("Roth401k", "Asset-NonLiquid") never surface in the UI.
export const ACCOUNT_TYPE_LABELS: Record<string, string> = {
  Cash: "Cash",
  Checking: "Checking",
  Savings: "Savings",
  CC: "Credit card",
  Investment: "Investment",
  Roth401k: "Roth 401(k)",
  "401k": "401(k)",
  HSA: "HSA",
  "Asset-NonLiquid": "Illiquid Asset",
  RSU: "RSU",
};

export function accountTypeLabel(type: string): string {
  return ACCOUNT_TYPE_LABELS[type] ?? type;
}

// Types whose value is already obvious from the account group heading
// (Credit / Banking), so a per-row type badge only repeats the section header.
const REDUNDANT_WITH_GROUP = new Set(["CC", "Checking", "Savings", "Cash"]);

// Whether to show the per-row type badge. Hidden for the liquid types the
// Credit/Banking headings already convey; shown (as a readable label) for the
// invested/locked sub-types where the specific kind actually adds information.
export function showTypeBadge(type: string): boolean {
  return !REDUNDANT_WITH_GROUP.has(type);
}
