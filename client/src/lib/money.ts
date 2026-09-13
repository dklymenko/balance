// Semantic colour + sign for monetary values, per the design tokens:
// income/credit = green, expense/debit = red, transfers stay neutral
// (de-emphasised), negative balances = orange, $0 = muted.

export function txAmountClass(type: string): string {
  if (type === "credit") return "text-income";
  if (type === "debit") return "text-expense";
  return ""; // transfer: neutral, inherits default text colour
}

export function txSign(type: string): string {
  return type === "credit" ? "+" : type === "debit" ? "−" : "";
}

// Colour an account balance / net-worth figure by sign.
export function balanceClass(valueUsd: number): string {
  if (valueUsd < 0) return "text-negative";
  if (valueUsd === 0) return "text-muted-foreground";
  return "";
}
