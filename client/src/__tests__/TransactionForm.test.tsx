import { type ComponentProps } from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import TransactionForm, { type Account } from "@/components/TransactionForm";

const ACCOUNTS: Account[] = [
  { id: 1, name: "Checking", base_currency: "USD", exchange_rate: 1, account_type: "Checking", liquidity_type: "Liquid", is_default: true, is_active: true },
  { id: 2, name: "Euro account", base_currency: "EUR", exchange_rate: 1.2, account_type: "Checking", liquidity_type: "Liquid", is_active: true },
];

const ALL_TAGS = [{ id: 7, name: "Disney vacation 2026" }];

function renderForm(props: Partial<ComponentProps<typeof TransactionForm>> = {}) {
  const onSave = vi.fn().mockResolvedValue(undefined);
  render(
    <TransactionForm open onClose={() => {}} onSave={onSave} accounts={ACCOUNTS} categories={[]} allTags={ALL_TAGS} defaultAccountId={1} {...props} />,
  );
  return { onSave };
}

function expectBefore(first: Element, second: Element) {
  expect(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
}

describe("TransactionForm -- exclude from reports (advanced flag, not shown on the form)", () => {
  it("defaults exclude_from_reports to false for a new transaction", async () => {
    const { onSave } = renderForm();
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: "50" } });
    fireEvent.submit(screen.getByRole("button", { name: /save/i }).closest("form")!);

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0][0]).toMatchObject({ account_id: 1, amount_usd: 50, exclude_from_reports: false });
  });

  it("preserves exclude_from_reports from the edited transaction", async () => {
    const initial = {
      id: 9, account_id: 1, category_id: null, date: "2026-01-01",
      description: "x", amount_fx: 10, exchange_rate: 1,
      type: "debit" as const, exclude_from_reports: true,
    };
    const { onSave } = renderForm({ initial });
    fireEvent.submit(screen.getByRole("button", { name: /save/i }).closest("form")!);

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0][0]).toMatchObject({ exclude_from_reports: true });
  });
});

describe("TransactionForm -- labels", () => {
  it("passes the transaction's labels (tag_ids) through to onSave", async () => {
    const initial = {
      id: 5, account_id: 1, category_id: null, date: "2026-01-01",
      description: "Park hotel", amount_fx: 100, exchange_rate: 1,
      type: "debit" as const, tag_ids: [7],
    };
    const { onSave } = renderForm({ initial });
    fireEvent.submit(screen.getByRole("button", { name: /save/i }).closest("form")!);

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    // Second argument is the selected label ids.
    expect(onSave.mock.calls[0][1]).toEqual([7]);
  });

  it("does not submit the transaction when a selected label is removed", () => {
    const initial = {
      id: 5, account_id: 1, category_id: null, date: "2026-01-01",
      description: "Park hotel", amount_fx: 100, exchange_rate: 1,
      type: "debit" as const, tag_ids: [7],
    };
    const { onSave } = renderForm({ initial });

    fireEvent.click(screen.getByRole("button", { name: "Remove label Disney vacation 2026" }));

    expect(onSave).not.toHaveBeenCalled();
    expect(screen.queryByText("Disney vacation 2026")).not.toBeInTheDocument();
  });

  it("shows inline feedback when a new label cannot be created", async () => {
    renderForm({ onCreateTag: vi.fn().mockResolvedValue(null) });
    fireEvent.click(screen.getByRole("button", { name: "Add label" }));
    fireEvent.change(screen.getByPlaceholderText("New label…"), { target: { value: "Review" } });
    fireEvent.click(screen.getByRole("button", { name: "Create label" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't create the label");
    expect(screen.getByPlaceholderText("New label…")).toHaveValue("Review");
  });
});

describe("TransactionForm -- amount and transfer integrity", () => {
  it("does not allow a zero-value transaction", () => {
    renderForm();
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: "0" } });
    expect(screen.getByRole("button", { name: /save/i })).toBeDisabled();
  });

  it("keeps both accounts when editing a transfer", async () => {
    const initial = {
      id: 20, account_id: 2, to_account_id: 1, transfer_group_id: "transfer-1",
      category_id: null, date: "2026-01-01", description: "Move cash",
      amount_fx: 25, exchange_rate: 1.2, type: "transfer" as const,
    };
    const { onSave } = renderForm({ initial });

    expect(screen.getByText("Amount (EUR)")).toBeInTheDocument();
    expect(screen.getByText("From Account")).toBeInTheDocument();
    expect(screen.getByText("To Account")).toBeInTheDocument();
    fireEvent.submit(screen.getByRole("button", { name: /save/i }).closest("form")!);

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0][0]).toMatchObject({
      account_id: 2,
      to_account_id: 1,
      amount_fx: 25,
      exchange_rate: 1.2,
      amount_usd: 30,
      type: "transfer",
    });
  });

  it("accepts a currency symbol that matches the selected account", async () => {
    const { onSave } = renderForm();
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: "$27" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0][0]).toMatchObject({ amount_fx: 27, amount_usd: 27 });
  });

  it("shows the account currency when a different currency symbol is entered", () => {
    renderForm();
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: "€23.50" } });

    expect(screen.getByRole("alert")).toHaveTextContent("USD only");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("uses the selected account's currency in the mismatch error", () => {
    renderForm({
      accounts: [{ id: 3, name: "UAH checking", base_currency: "UAH", exchange_rate: 0.024, account_type: "Checking", liquidity_type: "Liquid", is_default: true, is_active: true }],
      defaultAccountId: 3,
    });
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: "€23.50" } });

    expect(screen.getByRole("alert")).toHaveTextContent("UAH only");
  });

  it("submits with Enter only after a category is selected", async () => {
    const user = userEvent.setup();
    const { onSave } = renderForm({ categories: [{ id: 10, name: "Food", parent_id: null }] });
    const amount = screen.getByLabelText(/amount/i);

    await user.type(amount, "27{Enter}");
    expect(onSave).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Food" }));
    await user.click(amount);
    await user.keyboard("{Enter}");

    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
  });
});

describe("TransactionForm -- accessible field names", () => {
  it("names each custom selector for assistive technology", () => {
    renderForm();

    expect(screen.getByRole("combobox", { name: "Category" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Account" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Type" })).toBeInTheDocument();
  });

  it("distinguishes the source and destination selectors for transfers", () => {
    renderForm({ defaultType: "transfer" });

    expect(screen.getByRole("combobox", { name: "From Account" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "To Account" })).toBeInTheDocument();
  });
});

describe("TransactionForm -- category search", () => {
  it("ranks a matching top-level category ahead of matching sub-categories", async () => {
    renderForm({
      categories: [
        { id: 1, name: "Baby", parent_id: null },
        { id: 2, name: "Food", parent_id: null },
        { id: 3, name: "Baby food", parent_id: 1 },
      ],
    });

    fireEvent.click(screen.getByRole("combobox", { name: "Category" }));
    fireEvent.change(await screen.findByPlaceholderText("Search categories…"), { target: { value: "food" } });

    const topLevel = await screen.findByText("Food", { selector: "[cmdk-item]" });
    const child = await screen.findByText("Baby food", { selector: "[cmdk-item]" });
    expectBefore(topLevel, child);
  });
});

describe("TransactionForm -- save failures", () => {
  it("keeps the dialog usable and shows the error beside the form", async () => {
    renderForm({ onSave: vi.fn().mockRejectedValue(new Error("Synthetic save failed")) });
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: "25" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Synthetic save failed");
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    expect(screen.getByLabelText(/amount/i)).toHaveValue("25");
  });
});
