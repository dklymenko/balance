import { describe, it, expect } from "vitest";
import { categoryColor, CATEGORY_PALETTE, OTHER_COLOR } from "@/lib/categoryColors";

describe("categoryColors", () => {
  it("assigns palette colours by rank and wraps around", () => {
    expect(categoryColor(0)).toBe(CATEGORY_PALETTE[0]);
    expect(categoryColor(2)).toBe(CATEGORY_PALETTE[2]);
    expect(categoryColor(CATEGORY_PALETTE.length)).toBe(CATEGORY_PALETTE[0]); // wraps
    expect(categoryColor(CATEGORY_PALETTE.length + 3)).toBe(CATEGORY_PALETTE[3]);
  });

  it("uses a distinct neutral for the grouped 'Other'", () => {
    expect(OTHER_COLOR).not.toBe(CATEGORY_PALETTE[0]);
  });
});
