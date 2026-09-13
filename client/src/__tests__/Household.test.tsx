import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import Household from "@/pages/Household";

function meResponse(role: "admin" | "member") {
  return {
    user: { id: 1, email: "a@x.com", name: "Admin", role },
    household: { id: "h1", name: "Simpsons" },
  };
}

let resetBody: unknown = null;

function stubFetch(role: "admin" | "member") {
  resetBody = null;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/api/me")) return { ok: true, status: 200, json: async () => meResponse(role) };
      if (u.includes("/api/data/reset")) {
        resetBody = JSON.parse(String(init?.body ?? "{}"));
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      if (u.includes("/api/data/import")) return { ok: true, status: 201, json: async () => ({ imported: 3 }) };
      if (u.includes("/api/household")) return { ok: true, status: 200, json: async () => ({ members: [], pending: [] }) };
      return { ok: true, status: 200, json: async () => ({}) };
    }) as unknown as typeof fetch,
  );
}

function renderPage() {
  return render(<MemoryRouter><Household /></MemoryRouter>);
}

afterEach(() => vi.unstubAllGlobals());

describe("Household -- data export", () => {
  beforeEach(() => stubFetch("admin"));

  it("offers JSON and CSV download links to any member", async () => {
    renderPage();
    const json = await screen.findByText("Download JSON backup");
    const csv = screen.getByText("Download transactions CSV");
    expect(json).toHaveAttribute("href", "/api/data/export");
    expect(csv).toHaveAttribute("href", "/api/data/export/transactions.csv");
  });

  it("restores a selected JSON backup and reports success", async () => {
    renderPage();
    await screen.findByText("Download JSON backup");
    const file = {
      size: 100,
      text: vi.fn().mockResolvedValue(JSON.stringify({ format: "balance-archive", version: 1 })),
    };
    fireEvent.change(screen.getByLabelText("Choose JSON backup"), { target: { files: [file] } });
    expect(await screen.findByRole("status")).toHaveTextContent("Backup restored successfully (3 records).");
  });
});

describe("Household -- settings failures", () => {
  it("reports an identity load failure instead of leaving the page half initialized", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch);
    renderPage();
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't load settings");
  });

  it("restores the prior base currency when saving fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/me") {
        return { ok: true, status: 200, json: async () => ({
          ...meResponse("admin"), household: { ...meResponse("admin").household, base_currency: "USD" },
        }) };
      }
      if (url === "/api/settings" && init?.method === "PATCH") {
        return { ok: false, status: 500, json: async () => ({ error: "Settings are unavailable" }) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    }) as unknown as typeof fetch);

    renderPage();
    const currency = await screen.findByLabelText("Default account currency");
    fireEvent.change(currency, { target: { value: "EUR" } });

    expect(await screen.findByRole("alert")).toHaveTextContent("Settings are unavailable");
    expect(currency).toHaveValue("USD");
  });
});

describe("Household -- danger zone reset", () => {

  it("requires typing the exact household name before deleting, then posts the confirm", async () => {
    stubFetch("admin");
    renderPage();

    // Open the danger flow.
    fireEvent.click(await screen.findByRole("button", { name: /delete all financial data/i }));

    const deleteBtn = screen.getByRole("button", { name: /permanently delete/i });
    expect(deleteBtn).toBeDisabled(); // no confirmation typed yet

    const input = screen.getByPlaceholderText("Simpsons");
    fireEvent.change(input, { target: { value: "wrong" } });
    expect(deleteBtn).toBeDisabled(); // mismatch stays disabled

    fireEvent.change(input, { target: { value: "Simpsons" } });
    expect(deleteBtn).toBeEnabled();

    fireEvent.click(deleteBtn);
    await waitFor(() => expect(resetBody).toEqual({ confirm: "Simpsons" }));
    expect(await screen.findByText("All financial data deleted.")).toBeInTheDocument();
  });
});
