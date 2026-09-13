import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import MultiTransactionForm from "@/components/MultiTransactionForm";

describe("MultiTransactionForm accessibility", () => {
  it("names every row's category selector", () => {
    render(
      <MultiTransactionForm
        open
        onClose={() => {}}
        onSave={vi.fn().mockResolvedValue(undefined)}
        accounts={[{
          id: 1,
          name: "Checking",
          base_currency: "USD",
          exchange_rate: 1,
          account_type: "Checking",
          liquidity_type: "Liquid",
          is_default: true,
          is_active: true,
        }]}
        categories={[{ id: 1, name: "Groceries", parent_id: null, kind: "expense" }]}
        allTags={[]}
        defaultAccountId={1}
      />,
    );

    expect(screen.getAllByRole("combobox", { name: "Transaction category" })).toHaveLength(5);
  });

  it("shows a batch-save failure inside the open dialog", async () => {
    render(
      <MultiTransactionForm
        open
        onClose={() => {}}
        onSave={vi.fn().mockRejectedValue(new Error("Synthetic batch failed"))}
        accounts={[{
          id: 1,
          name: "Checking",
          base_currency: "USD",
          exchange_rate: 1,
          account_type: "Checking",
          liquidity_type: "Liquid",
          is_default: true,
          is_active: true,
        }]}
        categories={[]}
        allTags={[]}
        defaultAccountId={1}
      />,
    );

    fireEvent.change(screen.getAllByLabelText("Transaction amount")[0], { target: { value: "10" } });
    fireEvent.click(screen.getByRole("button", { name: "Save 1 transaction" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Synthetic batch failed");
    expect(screen.getByRole("button", { name: "Save 1 transaction" })).toBeEnabled();
  });
});
