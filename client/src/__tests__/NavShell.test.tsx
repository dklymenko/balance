import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import NavShell from "@/components/NavShell";

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<NavShell />}>
          <Route path="/transactions" element={<div>Transactions page</div>} />
          <Route path="/reports" element={<div>Reports page</div>} />
          <Route path="/accounts" element={<div>Accounts page</div>} />
          <Route path="/settings/household" element={<div>Settings page</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe("NavShell", () => {
  it("renders the four primary tabs (Transactions/Reports/Accounts/Settings) and the active page", () => {
    renderAt("/transactions");
    // Labels appear in both the desktop top bar and the mobile bottom bar.
    expect(screen.getAllByText("Transactions").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Reports").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Accounts").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Settings").length).toBeGreaterThan(0);
    expect(screen.getByText("Transactions page")).toBeInTheDocument();
  });

  it("renders the desktop navigation inside a top banner (horizontal bar)", () => {
    renderAt("/transactions");
    // The desktop nav lives in a <header> (banner) landmark -- the horizontal
    // top bar -- rather than a left/right sidebar.
    const banner = screen.getByRole("banner");
    expect(banner).toBeInTheDocument();
    expect(banner).toHaveTextContent("Transactions");
  });

  it("marks the current route's tab as active (aria-current)", () => {
    renderAt("/reports");
    const active = screen.getAllByRole("link", { current: "page" });
    expect(active.length).toBeGreaterThan(0);
    active.forEach((el) => expect(el).toHaveTextContent("Reports"));
  });
});
