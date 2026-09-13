import { describe, it, expect } from "vitest";
import { normalizeMerchant } from "../../lib/autoCategorize.js";

describe("normalizeMerchant", () => {
  it("strips store numbers, punctuation, and case so charge variants collide", () => {
    expect(normalizeMerchant("STARBUCKS #1234 SEATTLE")).toBe("starbucks seattle");
    expect(normalizeMerchant("Starbucks #0987 Seattle")).toBe("starbucks seattle");
    expect(normalizeMerchant("SQ *CORNER-CAFE 07/02")).toBe("sq corner cafe");
  });

  it("collapses whitespace and handles empty/no-letter input", () => {
    expect(normalizeMerchant("  FreshMart   44  Main St ")).toBe("freshmart main st");
    expect(normalizeMerchant("12345 --- 67")).toBe("");
    expect(normalizeMerchant("")).toBe("");
  });
});
