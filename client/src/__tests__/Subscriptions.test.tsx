import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import Subscriptions from "@/components/SubscriptionsReport";

function stubApi(body: unknown) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => body }));
}

afterEach(() => vi.unstubAllGlobals());

describe("Subscriptions", () => {
  it("shows the monthly total headline and each detected charge", async () => {
    stubApi({
      total_monthly_usd: 26.98,
      subscriptions: [
        { merchant: "streamly", description: "Streamly", category_name: "Subscriptions", monthly_usd: 15.99, last_charge: "2025-06-03", charges: 4 },
        { merchant: "musicnow", description: "MusicNow", category_name: null, monthly_usd: 10.99, last_charge: "2025-06-09", charges: 5 },
      ],
    });
    render(<Subscriptions />);

    expect(await screen.findByText("$26.98")).toBeInTheDocument();
    expect(screen.getByText("2 recurring charges")).toBeInTheDocument();
    expect(screen.getByText("Streamly")).toBeInTheDocument();
    expect(screen.getByText("MusicNow")).toBeInTheDocument();
    expect(screen.getByText(/4 charges/)).toBeInTheDocument();
  });

  it("explains itself when nothing is detected yet", async () => {
    stubApi({ total_monthly_usd: 0, subscriptions: [] });
    render(<Subscriptions />);
    expect(await screen.findByText(/No subscriptions detected yet/)).toBeInTheDocument();
  });

  it("shows a load error rather than claiming no subscriptions", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) }));
    render(<Subscriptions />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't load recurring charges");
    expect(screen.queryByText(/No subscriptions detected yet/)).not.toBeInTheDocument();
  });
});
