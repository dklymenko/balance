import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import Transactions from "@/pages/Transactions";

// 150 single (debit) transactions, same date so order is by id desc → tx-000 first.
const TXS = Array.from({ length: 150 }, (_, i) => ({
  id: 150 - i,
  account_id: 1,
  account_name: "Checking",
  category_id: null,
  category_name: null,
  date: "2025-06-01",
  description: `tx-${String(i).padStart(3, "0")}`,
  amount_fx: 1,
  exchange_rate: 1,
  amount_usd: 1,
  type: "debit",
  exclude_from_reports: false,
  created_at: "2025-06-01T00:00:00.000Z",
  tags: [],
}));

beforeEach(() => {
  // No-op observer → only the first page loads (no scroll-driven fetch).
  vi.stubGlobal("IntersectionObserver", class {
    observe() {} unobserve() {} disconnect() {}
  });
  // The server is paginated: honor limit/offset and return { rows, total }.
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const u = String(url);
    let body: unknown = [];
    if (u.includes("/api/transactions")) {
      const params = new URL(u, "http://localhost").searchParams;
      const limit = Number(params.get("limit") ?? "100");
      const offset = Number(params.get("offset") ?? "0");
      body = { rows: TXS.slice(offset, offset + limit), total: TXS.length };
    }
    return { ok: true, status: 200, json: async () => body };
  }) as unknown as typeof fetch);
});

afterEach(() => vi.unstubAllGlobals());

describe("Transactions -- server-side pagination", () => {
  it("shows an explicit error when the ledger page cannot be loaded", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes("/api/transactions")) {
        return { ok: false, status: 500, json: async () => ({ error: "failed" }) };
      }
      return { ok: true, status: 200, json: async () => [] };
    }) as unknown as typeof fetch);

    render(<MemoryRouter><Transactions /></MemoryRouter>);

    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't load transactions");
    expect(screen.queryByText(/No transactions yet/)).not.toBeInTheDocument();
  });

  it("requests only the first page and shows a 'showing N of total' sentinel", async () => {
    // The page now embeds router Links (onboarding checklist), so it needs the
    // Router context it always has in the app.
    render(<MemoryRouter><Transactions /></MemoryRouter>);

    // First page (server returned 100 rows) is rendered…
    expect(await screen.findByText("tx-000")).toBeInTheDocument();
    expect(screen.getByText("tx-099")).toBeInTheDocument();
    // …rows beyond the page were never fetched, so they're not in the DOM.
    expect(screen.queryByText("tx-100")).not.toBeInTheDocument();
    expect(screen.queryByText("tx-149")).not.toBeInTheDocument();
    // Sentinel reports loaded-of-total progress against the server's total.
    expect(screen.getByText(/100 \/ 150/)).toBeInTheDocument();

    // Only the first page was requested from the server (limit=100&offset=0),
    // never the whole ledger.
    const calls = (fetch as unknown as { mock: { calls: [string][] } }).mock.calls
      .map((c) => String(c[0]))
      .filter((u) => u.includes("/api/transactions"));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("limit=100");
    expect(calls[0]).toContain("offset=0");
  });
});
