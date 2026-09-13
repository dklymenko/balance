// @balance/core finance: Balance's shared integer-cents money convention (see
// server/src/lib/finance.ts for the dollars-API boundary helpers).
//
// Money is stored as integer cents so balances stay exact (no float drift
// like 0.1 + 0.2 = 0.30000000000000004, and SUM() over cents is exact).
// There is no dollars-speaking HTTP boundary in this package:
// the repo layer, the sync wire format, and the DB all use cents. Conversion
// happens only at the UI edge (parse on input, format on display).

export type TransactionType = "debit" | "credit" | "transfer";
export type TransferDirection = "out" | "in";

// The widest money magnitude Balance persists, in integer cents (+/- $1
// trillion). Every stored cents value must stay inside this range AND inside
// the JavaScript safe-integer range: past 2^53 a "number" is no longer an
// exact integer, and SQLite then stores it in an integer column with REAL
// affinity, which silently ends the exact-cents guarantee the whole ledger
// rests on. The archive validator and every server write path share this one
// definition so a value the API accepts can always be re-imported.
export const MAX_CENTS = 100_000_000_000_000;

export function isStorableCents(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && Math.abs(value) <= MAX_CENTS;
}

// Signed balance delta for a debit/credit row, in cents.
export function signedDelta(type: TransactionType, amountCents: number): number {
  return type === "credit" ? amountCents : -amountCents;
}

export function toCents(dollars: number): number {
  return Math.round(dollars * 100);
}

export function fromCents(cents: number): number {
  return cents / 100;
}

// Parse free-form user input ("1,234.56", "1234,56", "$12") into cents.
// Never parseFloat raw input: a comma can be a thousands separator or a
// locale decimal separator (budget-app parser pattern). Returns null when the
// input is not a positive amount.
export function parseAmountToCents(raw: string): number | null {
  let s = raw.trim().replace(/[$€£\s]/g, "");
  if (!s) return null;
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  if (lastComma !== -1 && lastDot !== -1) {
    // Both present: the later one is the decimal separator.
    if (lastComma > lastDot) s = s.replace(/\./g, "").replace(",", ".");
    else s = s.replace(/,/g, "");
  } else if (lastComma !== -1) {
    // A lone comma is a decimal separator when it has 1-2 trailing digits
    // ("1234,56"); otherwise treat commas as thousands separators ("1,234").
    const frac = s.length - lastComma - 1;
    if (frac >= 1 && frac <= 2 && s.indexOf(",") === lastComma) s = s.replace(",", ".");
    else s = s.replace(/,/g, "");
  }
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return null;
  return toCents(n);
}

// Display formatting. Fall back to a plain fixed-point string if the runtime
// does not recognize a currency code.
export function formatCents(cents: number, currency = "USD"): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
    }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}
