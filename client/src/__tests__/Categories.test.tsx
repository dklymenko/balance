import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import Categories from "@/pages/Categories";

afterEach(() => vi.unstubAllGlobals());

describe("Categories failure handling", () => {
  it("shows an explicit error when categories cannot be loaded", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/categories") return { ok: false, status: 500, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => [] };
    }) as unknown as typeof fetch);

    render(<Categories />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't load categories");
    await waitFor(() => expect(screen.queryByText("Loading…")).not.toBeInTheDocument());
  });

  it("keeps a duplicate label in the form and surfaces the server message", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/tags" && init?.method === "POST") {
        return { ok: false, status: 409, json: async () => ({ error: "A tag with this name already exists" }) };
      }
      return { ok: true, status: 200, json: async () => [] };
    }) as unknown as typeof fetch);

    render(<Categories />);
    const input = await screen.findByPlaceholderText(/New label/i);
    fireEvent.change(input, { target: { value: "reviewed" } });
    const form = input.closest("form");
    fireEvent.submit(form!);

    expect(await screen.findByRole("alert")).toHaveTextContent("A tag with this name already exists");
    expect(input).toHaveValue("reviewed");
  });
});

describe("Categories accessibility", () => {
  it("names the optional parent selector", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => [] })) as unknown as typeof fetch);

    render(<Categories />);
    await waitFor(() => expect(screen.queryByText("Loading…")).not.toBeInTheDocument());
    fireEvent.click(screen.getAllByRole("button", { name: "Add" })[0]);

    expect(screen.getByRole("combobox", { name: "Parent (optional)" })).toBeInTheDocument();
  });

  it("shows category-save failures inside the open dialog", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        return { ok: false, status: 409, json: async () => ({ error: "Synthetic category conflict" }) };
      }
      return { ok: true, status: 200, json: async () => [] };
    }) as unknown as typeof fetch);

    render(<Categories />);
    await waitFor(() => expect(screen.queryByText("Loading…")).not.toBeInTheDocument());
    fireEvent.click(screen.getAllByRole("button", { name: "Add" })[0]);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Groceries" } });
    fireEvent.submit(screen.getByRole("button", { name: "Save" }).closest("form")!);

    expect(await screen.findByRole("alert")).toHaveTextContent("Synthetic category conflict");
    expect(screen.getByRole("dialog", { name: "Add Category" })).toBeInTheDocument();
  });
});
