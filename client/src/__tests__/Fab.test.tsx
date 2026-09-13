import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import Fab from "@/components/Fab";

describe("Fab speed dial", () => {
  it("hides actions until opened, then invokes the chosen action and closes", () => {
    const expense = vi.fn();
    render(
      <Fab
        label="Add transaction"
        actions={[
          { label: "Expense", onClick: expense },
          { label: "Income", onClick: vi.fn() },
          { label: "Transfer", onClick: vi.fn() },
        ]}
      />,
    );

    // Collapsed: action pills are not rendered.
    expect(screen.queryByText("Expense")).not.toBeInTheDocument();

    // Open the speed dial.
    fireEvent.click(screen.getByRole("button", { name: "Add transaction" }));
    expect(screen.getByText("Expense")).toBeInTheDocument();
    expect(screen.getByText("Transfer")).toBeInTheDocument();

    // Choosing an action fires its handler and collapses the dial.
    fireEvent.click(screen.getByText("Expense"));
    expect(expense).toHaveBeenCalledOnce();
    expect(screen.queryByText("Expense")).not.toBeInTheDocument();
  });
});
