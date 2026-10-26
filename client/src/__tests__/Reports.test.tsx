import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import Reports from "@/pages/Reports";
import { buildCategoryTree, netIncomeTrend, reportMonths } from "@/lib/reportHelpers";

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, status: 200, json: async () => [] })) as unknown as typeof fetch,
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("Reports -- sub-nav + navigation", () => {
  it("shows a load error instead of an endless or misleading empty report", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500, json: async () => ({ error: "failed" }) })) as unknown as typeof fetch,
    );
    render(<Reports />);
    expect(await screen.findByText("Couldn't load spending report.")).toHaveAttribute("role", "alert");
  });

  it("shows a horizontal report sub-nav with Spend by Category first and active by default", async () => {
    render(<Reports />);

    // All four report tabs are present in the sub-nav.
    expect(await screen.findByRole("button", { name: /Spend by Category/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Income vs Spend/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Spend Over Time/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Period Comparison/i })).toBeInTheDocument();

    // Spend by Category is the default (its tab is the current page).
    const active = screen.getAllByRole("button", { current: "page" });
    expect(active.length).toBe(1);
    expect(active[0]).toHaveTextContent("Spend by Category");
  });

  it("switches reports from the sub-nav, updating the period chips", async () => {
    render(<Reports />);
    fireEvent.click(await screen.findByRole("button", { name: /Period Comparison/i }));

    // Period Comparison offers a Custom period; its tab becomes active.
    expect(screen.getByRole("button", { name: /^Custom$/i })).toBeInTheDocument();
    const active = screen.getAllByRole("button", { current: "page" });
    expect(active[0]).toHaveTextContent("Period Comparison");
    // Let the comparison's four report requests settle before the test
    // unmounts, so its loading-state updates stay inside Testing Library's act.
    expect(await screen.findByText("Not enough data to compare.")).toBeInTheDocument();
  });
});

describe("Spend by Category hierarchy", () => {
  it("rolls subcategory spend into a parent that has no direct transactions", () => {
    const tree = buildCategoryTree(
      [{ category_id: 2, category_name: "Groceries", parent_id: 1, total_usd: 31 }],
      [
        { id: 1, name: "Food", parent_id: null },
        { id: 2, name: "Groceries", parent_id: 1 },
      ],
    );

    expect(tree).toHaveLength(1);
    expect(tree[0]).toMatchObject({ id: 1, name: "Food", total: 31 });
    expect(tree[0].children).toEqual([
      expect.objectContaining({ id: 2, name: "Groceries", total: 31 }),
    ]);
  });
});

describe("Spend Over Time range", () => {
  it("uses the period selected by the user", () => {
    expect(reportMonths("2026-08", "2026-08")).toEqual(["2026-08"]);
    expect(reportMonths("2026-06", "2026-08")).toEqual(["2026-06", "2026-07", "2026-08"]);
  });
});

describe("Net income trend summary", () => {
  it("describes an improving positive trend without overclaiming savings", () => {
    expect(netIncomeTrend(1_200, 1_800)).toEqual({
      direction: "up",
      message: "Net income is trending up",
    });
  });

  it("does not claim spending exceeds income when net income remains positive", () => {
    expect(netIncomeTrend(2_400, 900)).toEqual({
      direction: "down",
      message: "Net income is positive, but trending down",
    });
  });

  it("only warns that spending exceeds income when net income is negative", () => {
    expect(netIncomeTrend(600, -250)).toEqual({
      direction: "down",
      message: "Spending is currently higher than income",
    });
  });
});

describe("Reports -- Spend Over Time filters", () => {
  beforeEach(() => {
    localStorage.clear();
    const categories = [
      { id: 11, name: "ABA", parent_id: 1 },
      { id: 21, name: "Airbnb", parent_id: 2 },
      { id: 1, name: "Kids", parent_id: null },
      { id: 2, name: "Travel", parent_id: null },
    ];
    const tags = [{ id: 5, name: "Trip" }];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => ({
      ok: true, status: 200,
      json: async () => (String(url).startsWith("/api/categories") ? categories : String(url).startsWith("/api/tags") ? tags : []),
    })) as unknown as typeof fetch);
  });

  it("lists categories parent → children in the Categories pop-up", async () => {
    render(<Reports />);
    fireEvent.click(await screen.findByRole("button", { name: /Spend Over Time/i }));
    fireEvent.click(await screen.findByRole("button", { name: "Categories" }));
    const names = (await screen.findAllByRole("checkbox"))
      .map(el => el.textContent)
      .filter(n => ["ABA", "Airbnb", "Kids", "Travel"].includes(n ?? ""));
    expect(names).toEqual(["Kids", "ABA", "Travel", "Airbnb"]);
  });

  it("filters by label and clears it with the × beside the button", async () => {
    render(<Reports />);
    fireEvent.click(await screen.findByRole("button", { name: /Spend Over Time/i }));
    expect(screen.queryByRole("button", { name: "Clear labels filter" })).not.toBeInTheDocument();

    fireEvent.click(await screen.findByRole("button", { name: "Labels" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "Trip" }));
    const calls = () => (fetch as unknown as { mock: { calls: [string][] } }).mock.calls.map(([u]) => String(u));
    expect(calls().some(u => u.startsWith("/api/reports/spend-over-time") && u.includes("tag_ids=5"))).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Clear labels filter" }));
    expect(screen.queryByRole("button", { name: "Clear labels filter" })).not.toBeInTheDocument();
    expect(calls().at(-1)).toMatch(/^\/api\/reports\/spend-over-time(?!.*tag_ids)/);
  });
});
