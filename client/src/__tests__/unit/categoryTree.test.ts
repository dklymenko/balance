import { describe, it, expect } from "vitest";
import { simplifyCategoryTree } from "@/lib/categoryTree";

type N = { id: number | null; name: string; total: number; children: N[] };
const n = (id: number, name: string, total: number, children: N[] = []): N => ({ id, name, total, children });

describe("simplifyCategoryTree", () => {
  it("drops empty sub-categories, leaving a plain top-level row", () => {
    const [car] = simplifyCategoryTree([n(1, "Car", 50, [n(11, "Wash", 0), n(12, "Parking", 0)])]);
    expect(car).toMatchObject({ id: 1, name: "Car", total: 50, children: [] });
  });

  it("shows a lone spending sub-category instead of its parent", () => {
    const [row] = simplifyCategoryTree([n(1, "Travel", 2813, [n(11, "Airbnb", 2813), n(12, "Hotel", 0)])]);
    expect(row).toMatchObject({ id: 11, name: "Airbnb", total: 2813, children: [] });
  });

  it("keeps nesting when the parent has spend of its own beside the one child", () => {
    const [row] = simplifyCategoryTree([n(1, "Food", 100, [n(11, "Groceries", 60), n(12, "Snacks", 0)])]);
    expect(row.name).toBe("Food");
    expect(row.children.map((c) => c.name)).toEqual(["Groceries"]);
  });

  it("keeps nesting for two or more spending sub-categories", () => {
    const [row] = simplifyCategoryTree([n(1, "Kids", 300, [n(11, "ABA", 200), n(12, "ABM", 100), n(13, "School", 0)])]);
    expect(row.children.map((c) => c.name)).toEqual(["ABA", "ABM"]);
  });
});
