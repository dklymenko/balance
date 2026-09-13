import { describe, it, expect } from "vitest";
import { txAmountClass, txSign, balanceClass } from "@/lib/money";

describe("money helpers", () => {
  it("colours transaction amounts by type", () => {
    expect(txAmountClass("credit")).toBe("text-income");
    expect(txAmountClass("debit")).toBe("text-expense");
    expect(txAmountClass("transfer")).toBe(""); // neutral
  });

  it("signs amounts by type", () => {
    expect(txSign("credit")).toBe("+");
    expect(txSign("debit")).toBe("−");
    expect(txSign("transfer")).toBe("");
  });

  it("colours balances by sign", () => {
    expect(balanceClass(-5)).toBe("text-negative");
    expect(balanceClass(0)).toBe("text-muted-foreground");
    expect(balanceClass(100)).toBe("");
  });
});
