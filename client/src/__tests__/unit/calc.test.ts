import { describe, it, expect } from "vitest";
import { evalExpression, hasOperator } from "@/lib/calc";

describe("evalExpression", () => {
  it("parses a plain number", () => {
    expect(evalExpression("50")).toBe(50);
    expect(evalExpression("12.5")).toBe(12.5);
  });

  it("evaluates chained arithmetic left-to-right", () => {
    expect(evalExpression("12+3")).toBe(15);
    expect(evalExpression("100-5-5")).toBe(90);
    expect(evalExpression("27+13-9")).toBe(31);
    expect(evalExpression("2+3×4")).toBe(20); // (2+3)*4 left-to-right, not 14
    expect(evalExpression("10÷4")).toBe(2.5);
  });

  it("accepts ascii operators too", () => {
    expect(evalExpression("2*3")).toBe(6);
    expect(evalExpression("9/3")).toBe(3);
  });

  it("returns null for empty, trailing-operator, or malformed input", () => {
    expect(evalExpression("")).toBeNull();
    expect(evalExpression("12+")).toBeNull();
    expect(evalExpression("abc")).toBeNull();
  });

  it("guards divide-by-zero", () => {
    expect(evalExpression("1÷0")).toBeNull();
  });
});

describe("hasOperator", () => {
  it("detects a pending operator, ignoring a leading minus", () => {
    expect(hasOperator("12+3")).toBe(true);
    expect(hasOperator("50")).toBe(false);
    expect(hasOperator("-5")).toBe(false);
  });
});
