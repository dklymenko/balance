import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import OnboardingChecklist from "@/components/OnboardingChecklist";

function renderChecklist(over: Partial<Parameters<typeof OnboardingChecklist>[0]> = {}) {
  return render(
    <MemoryRouter>
      <OnboardingChecklist
        accountCount={0}
        transactionCount={0}
        isCloudProfile={false}
        onSampleLoaded={vi.fn()}
        {...over}
      />
    </MemoryRouter>,
  );
}

beforeEach(() => localStorage.clear());
afterEach(() => vi.unstubAllGlobals());

describe("OnboardingChecklist", () => {
  it("shows the three steps and the sample-data offer for an empty household", () => {
    renderChecklist();
    expect(screen.getByText("Welcome to Balance")).toBeInTheDocument();
    expect(screen.getByText("Add your first account")).toBeInTheDocument();
    expect(screen.getByText("Add or import transactions")).toBeInTheDocument();
    expect(screen.getByText("View your first report")).toBeInTheDocument();
    expect(screen.getByText("Or explore with sample data")).toBeInTheDocument();
  });

  it("hides the sample-data offer once an account exists (server would refuse it)", () => {
    renderChecklist({ accountCount: 1 });
    expect(screen.getByText("Welcome to Balance")).toBeInTheDocument();
    expect(screen.queryByText("Or explore with sample data")).not.toBeInTheDocument();
  });

  it("never greets a household that already has data", () => {
    renderChecklist({ accountCount: 3, transactionCount: 50 });
    expect(screen.queryByText("Welcome to Balance")).not.toBeInTheDocument();
  });

  it("keeps guiding a started household until every step is done", () => {
    renderChecklist(); // empty household → starts onboarding
    // Later visit: data exists but no report viewed yet → still shown.
    renderChecklist({ accountCount: 1, transactionCount: 5 });
    expect(screen.getAllByText("Welcome to Balance").length).toBeGreaterThan(0);
  });

  it("does not carry an empty-device welcome into a populated Cloud household", () => {
    const firstRun = renderChecklist(); // enrollment begins against an empty replica
    firstRun.unmount();
    render(
      <MemoryRouter>
        <OnboardingChecklist
          accountCount={3}
          transactionCount={50}
          isCloudProfile
          onSampleLoaded={vi.fn()}
        />
      </MemoryRouter>,
    );
    expect(screen.queryByText("Welcome to Balance")).not.toBeInTheDocument();
  });

  it("dismissing persists across renders", () => {
    renderChecklist();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss getting started" }));
    expect(screen.queryByText("Welcome to Balance")).not.toBeInTheDocument();
    renderChecklist();
    expect(screen.queryByText("Welcome to Balance")).not.toBeInTheDocument();
  });

  it("loads the sample dataset and notifies the parent", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal("fetch", fetchMock);
    const onSampleLoaded = vi.fn();

    renderChecklist({ onSampleLoaded });
    fireEvent.click(screen.getByText("Or explore with sample data"));

    await waitFor(() => expect(onSampleLoaded).toHaveBeenCalledOnce());
    expect(fetchMock).toHaveBeenCalledWith("/api/data/sample", { method: "POST" });
  });

  it("surfaces the server's error when seeding is refused", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ error: "Sample data can only be loaded into an empty household." }),
    }));
    renderChecklist();
    fireEvent.click(screen.getByText("Or explore with sample data"));
    expect(await screen.findByText(/only be loaded into an empty household/)).toBeInTheDocument();
  });
});
