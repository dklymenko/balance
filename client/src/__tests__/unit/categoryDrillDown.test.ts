import { describe, it, expect } from "vitest";
import { drillDownCategoryIds, groupDrillDown, type DrillDownRow } from "@/components/CategoryDrillDown";

const CATS = [
  { id: 1, name: "Kids", parent_id: null },
  { id: 11, name: "ABA", parent_id: 1 },
  { id: 12, name: "ABM", parent_id: 1 },
  { id: 2, name: "Travel", parent_id: null },
];

const row = (id: number, category_id: number | null, amount_usd: number): DrillDownRow =>
  ({ id, date: `2026-09-${String(30 - id).padStart(2, "0")}`, description: `t${id}`, amount_usd, category_id, account_name: "Card" });

describe("drillDownCategoryIds", () => {
  it("covers a parent and its children, a leaf alone, and nothing for Uncategorized", () => {
    expect(drillDownCategoryIds({ id: 1, name: "Kids" }, CATS)).toEqual([1, 11, 12]);
    expect(drillDownCategoryIds({ id: 11, name: "ABA" }, CATS)).toEqual([11]);
    expect(drillDownCategoryIds({ id: null, name: "Uncategorized" }, CATS)).toEqual([]);
  });
});

describe("groupDrillDown", () => {
  it("groups by sub-category, biggest subtotal first, keeping row order inside a group", () => {
    const rows = [row(1, 11, 100), row(2, 12, 300), row(3, 11, 150), row(4, 1, 20)];
    const groups = groupDrillDown(rows, { id: 1, name: "Kids" }, CATS);
    expect(groups.map(g => [g.name, g.total, g.rows.map(r => r.id)])).toEqual([
      ["ABM", 300, [2]],
      ["ABA", 250, [1, 3]],
      ["Kids (general)", 20, [4]],
    ]);
  });

  it("uses the category's own name when it has no children", () => {
    expect(groupDrillDown([row(1, 2, 10)], { id: 2, name: "Travel" }, CATS).map(g => g.name)).toEqual(["Travel"]);
  });
});
