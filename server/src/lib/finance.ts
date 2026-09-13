import type { TransactionType } from "../db/schema.js";
import { isStorableCents, MAX_CENTS } from "@balance/core";

export { isStorableCents, MAX_CENTS };

// Money columns hold integer cents. amount_fx and exchange_rate are each
// bounded at the request boundary, but their PRODUCT is not, so a request can
// derive a USD value past the safe-integer range. SQLite then keeps that float
// in an integer column, exact-cents arithmetic stops holding, and the ledger's
// own archive export no longer passes import validation. Every derived money
// value goes through here so that cannot happen.
export function assertStorableCents(value: number, field: string): number {
  if (!isStorableCents(value)) {
    throw Object.assign(
      new Error(`${field} is outside the supported money range`),
      { status: 400 },
    );
  }
  return value;
}

// amount_usd is always derived server-side from native cents x exchange rate.
export function deriveUsdCents(amountFxCents: number, exchangeRate: number): number {
  return assertStorableCents(Math.round(amountFxCents * exchangeRate), "amount_fx x exchange_rate");
}

export function deriveMarketValueCents(shares: number, priceCents: number): number {
  return assertStorableCents(Math.round(shares * priceCents), "RSU market value");
}

// Budget-app CSV exports may use either comma or period decimal separators.
// Reject partial or ambiguous garbage instead of silently turning it into zero.
export function parseBudgetAppAmount(raw: string): number | null {
  let normalized = raw.trim().replace(/[\s\u00a0$€£]/g, "");
  const wrapped = /^\((.*)\)$/.exec(normalized);
  if (wrapped) normalized = `-${wrapped[1]}`;
  const comma = normalized.lastIndexOf(",");
  const dot = normalized.lastIndexOf(".");
  if (comma >= 0 && dot >= 0) {
    const decimal = comma > dot ? "," : ".";
    const thousands = decimal === "," ? /\./g : /,/g;
    normalized = normalized.replace(thousands, "").replace(decimal, ".");
  } else if (comma >= 0) {
    const pieces = normalized.split(",");
    normalized = pieces.length === 2 && /^\d{1,2}$/.test(pieces[1])
      ? `${pieces[0]}.${pieces[1]}`
      : pieces.join("");
  }
  if (!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(normalized)) return null;
  const amount = Math.abs(Number(normalized));
  return Number.isFinite(amount) && amount > 0 && amount <= 1e12 ? amount : null;
}

// Signed balance delta, in the SAME unit as `amount`. Money is stored as
// integer cents, so callers pass cents and get cents back.
export function signedDelta(type: TransactionType, amount: number): number {
  return type === "credit" ? amount : -amount;
}

// Money is stored as integer cents so balances stay exact (no float drift
// like 0.1 + 0.2 = 0.30000000000000004, and SUM() over cents is exact).
// The JSON API speaks dollars, so convert at the request/response boundary:
// toCents on the way in, fromCents on the way out.
export function toCents(dollars: number): number {
  return Math.round(dollars * 100);
}

export function fromCents(cents: number): number {
  return cents / 100;
}
