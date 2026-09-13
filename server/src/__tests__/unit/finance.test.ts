import { describe, it, expect } from "vitest";
import { parseBudgetAppAmount, signedDelta, toCents, fromCents } from "../../lib/finance.js";

describe("toCents / fromCents", () => {
  it("converts dollars to integer cents", () => expect(toCents(35111.59)).toBe(3511159));
  it("rounds to the nearest cent, eliminating float drift", () => expect(toCents(0.1 + 0.2)).toBe(30));
  it("handles negatives", () => expect(toCents(-0.1 - 0.2)).toBe(-30));
  it("round-trips dollars → cents → dollars", () => expect(fromCents(toCents(1234.56))).toBe(1234.56));
  it("sums exactly in cents (0.1 + 0.2 = 0.3)", () => expect(fromCents(toCents(0.1) + toCents(0.2))).toBe(0.3));
  it("returns 0 for 0", () => { expect(toCents(0)).toBe(0); expect(fromCents(0)).toBe(0); });
});

describe("parseBudgetAppAmount", () => {
  it("parses standard decimal", () => expect(parseBudgetAppAmount("1234.56")).toBe(1234.56));
  it("parses comma as decimal separator", () => expect(parseBudgetAppAmount("1500,25")).toBe(1500.25));
  it("rejects an empty amount", () => expect(parseBudgetAppAmount("")).toBeNull());
  it("rejects non-numeric text", () => expect(parseBudgetAppAmount("abc")).toBeNull());
  it("normalizes signed values because the CSV type column carries direction", () => expect(parseBudgetAppAmount("-50,00")).toBe(50));
  it("rejects zero-value transactions", () => expect(parseBudgetAppAmount("0")).toBeNull());
});

describe("signedDelta", () => {
  it("credit returns positive amount", () => expect(signedDelta("credit", 100)).toBe(100));
  it("debit returns negative amount", () => expect(signedDelta("debit", 100)).toBe(-100));
  it("transfer returns negative amount (same as debit)", () => expect(signedDelta("transfer", 100)).toBe(-100));
  it("operates on integer cents", () => expect(signedDelta("credit", 1234)).toBe(1234));
});
