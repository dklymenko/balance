import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import Accounts from "@/pages/Accounts";
import { isAccountStale, type Account } from "@/components/SortableAccountRow";
import { setAdvancedFeatures } from "@/lib/features";

function account(partial: Partial<Account> & { id: number; name: string }): Account {
  return {
    account_type: "Checking",
    base_currency: "USD",
    liquidity_type: "Liquid",
    balance: 100,
    exchange_rate: 1,
    balance_usd: 100,
    ticker: null,
    shares_quantity: null,
    current_price_usd: null,
    market_value: null,
    sort_order: null,
    notes: null,
    is_default: false,
    is_active: true,
    last_activity_at: "2026-09-19T00:00:00.000Z",
    ...partial,
  };
}

const DATA: Account[] = [
  account({ id: 1, name: "BofA Check" }),
  account({ id: 2, name: "PUMB Legacy", is_active: false }),
];

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, status: 200, json: async () => DATA })) as unknown as typeof fetch,
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  setAdvancedFeatures(false);
});

describe("Accounts page -- inactive accounts", () => {
  it("hides inactive accounts by default and reveals them via the toggle", async () => {
    render(<Accounts />);

    // Active account is shown once loaded.
    expect(await screen.findByText("BofA Check")).toBeInTheDocument();
    // Inactive account is hidden by default.
    expect(screen.queryByText("PUMB Legacy")).not.toBeInTheDocument();

    // Toggle appears with the inactive count and reveals the inactive account.
    const toggle = screen.getByRole("button", { name: /show inactive \(1\)/i });
    fireEvent.click(toggle);

    expect(await screen.findByText("PUMB Legacy")).toBeInTheDocument();
    expect(screen.getByText("Inactive")).toBeInTheDocument();

    // Toggling again hides it.
    fireEvent.click(screen.getByRole("button", { name: /hide inactive/i }));
    await waitFor(() => expect(screen.queryByText("PUMB Legacy")).not.toBeInTheDocument());
  });

  it("shows net worth (including inactive accounts) by default", async () => {
    render(<Accounts />);
    // 100 (active) + 100 (inactive) = $200.00 net worth -- shown by default in the
    // mobile headline and the desktop summary panel (both are in the DOM in jsdom).
    expect((await screen.findAllByText("$200.00")).length).toBeGreaterThan(0);
  });
});

describe("Accounts page -- edit mode", () => {
  it("reveals delete controls only in edit mode and confirms before deleting", async () => {
    render(<Accounts />);
    await screen.findByText("BofA Check");

    // Clean by default -- no per-row delete control.
    expect(screen.queryByRole("button", { name: /delete bofa check/i })).not.toBeInTheDocument();

    // Enter edit mode → "Done" + delete controls appear.
    fireEvent.click(screen.getByRole("button", { name: /^edit$/i }));
    expect(screen.getByRole("button", { name: /^done$/i })).toBeInTheDocument();
    const del = screen.getByRole("button", { name: /delete bofa check/i });

    // Tapping delete opens a confirm dialog (does not delete immediately).
    fireEvent.click(del);
    expect(await screen.findByText("Delete account?")).toBeInTheDocument();
  });
});

describe("Accounts page -- accessible account form", () => {
  it("names the type and liquidity selectors", async () => {
    render(<Accounts />);
    await screen.findByText("BofA Check");

    fireEvent.click(screen.getByRole("button", { name: "Add Account" }));

    expect(screen.getByRole("combobox", { name: "Type" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Liquidity" })).toBeInTheDocument();
  });

  it("keeps an existing balance read-only and saves corrections through the ledger endpoint", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => ({
      ok: true,
      status: init?.method === "POST" ? 201 : 200,
      json: async () => init?.method === "POST" ? { transaction_id: 42, balance: 125 } : DATA,
    }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    render(<Accounts />);
    fireEvent.click(await screen.findByText("BofA Check"));

    expect(screen.getByLabelText(/Balance \(USD\)/)).toHaveAttribute("readonly");
    fireEvent.click(screen.getByRole("button", { name: "Correct balance…" }));
    fireEvent.change(screen.getByLabelText("Correct balance (USD)"), { target: { value: "125" } });
    fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2026-09-20" } });
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Bank statement reconciliation" } });
    fireEvent.submit(screen.getByRole("button", { name: "Save correction" }).closest("form")!);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/accounts/1/correct",
      expect.objectContaining({ method: "POST" }),
    ));
    const call = fetchMock.mock.calls.find(([input]) => input === "/api/accounts/1/correct")!;
    expect(JSON.parse(String(call[1]?.body))).toMatchObject({
      balance: 125,
      reason: "Bank statement reconciliation",
    });
  });

  it("shows account-save failures inside the open dialog", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        return { ok: false, status: 409, json: async () => ({ error: "Synthetic account conflict" }) };
      }
      return { ok: true, status: 200, json: async () => DATA };
    }) as unknown as typeof fetch);

    render(<Accounts />);
    await screen.findByText("BofA Check");
    fireEvent.click(screen.getByRole("button", { name: "Add Account" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "New account" } });
    fireEvent.change(screen.getByLabelText(/Balance/), { target: { value: "100" } });
    fireEvent.submit(screen.getByRole("button", { name: "Save" }).closest("form")!);

    expect(await screen.findByRole("alert")).toHaveTextContent("Synthetic account conflict");
    expect(screen.getByRole("dialog", { name: "Add Account" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });
});

describe("account freshness", () => {
  it("flags active accounts at 14 days and ignores inactive accounts", () => {
    const now = Date.parse("2026-09-20T00:00:00.000Z");
    expect(isAccountStale(account({ id: 1, name: "Old", last_activity_at: "2026-09-06T00:00:00.000Z" }), now)).toBe(true);
    expect(isAccountStale(account({ id: 2, name: "Recent", last_activity_at: "2026-09-07T00:00:00.000Z" }), now)).toBe(false);
    expect(isAccountStale(account({ id: 3, name: "Inactive", is_active: false, last_activity_at: "2026-01-01T00:00:00.000Z" }), now)).toBe(false);
  });
});
