import { describe, it, expect } from "vitest";
import { categoryGroups, categorySelectionChips } from "@/components/FilterChecklist";

// The API returns categories as one flat list sorted by name, so children
// (ABA, ABM, Airbnb) arrive before -- and far away from -- their parents.
const FLAT = [
  { id: 11, name: "ABA", parent_id: 1 },
  { id: 12, name: "ABM", parent_id: 1 },
  { id: 21, name: "Airbnb", parent_id: 2 },
  { id: 1, name: "Kids", parent_id: null },
  { id: 2, name: "Travel", parent_id: null },
  { id: 3, name: "Utilities", parent_id: null },
  { id: 99, name: "Orphan", parent_id: 500 },
];

describe("categoryGroups", () => {
  it("nests each child under its parent, both levels sorted by name", () => {
    expect(categoryGroups(FLAT).map(g => [g.parent.name, g.children.map(c => c.name)])).toEqual([
      ["Kids", ["ABA", "ABM"]],
      ["Orphan", []],
      ["Travel", ["Airbnb"]],
      ["Utilities", []],
    ]);
  });
});

describe("categorySelectionChips", () => {
  it("collapses a fully-selected group to its parent and lists partial picks", () => {
    expect(categorySelectionChips(FLAT, new Set([1, 11, 12, 21]))).toEqual([
      { label: "Kids", ids: [1, 11, 12] },
      { label: "Airbnb", ids: [21] },
    ]);
  });
});
