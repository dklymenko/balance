import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import CloudSyncSection from "@/components/CloudSyncSection";
import type { DesktopCloud } from "@/lib/desktopBridge";

function stubBridge(cloud: Partial<DesktopCloud> | undefined) {
  (window as unknown as { balanceDesktop?: unknown }).balanceDesktop =
    cloud ? { scrapeAmazon: vi.fn(), cloud } : undefined;
}

afterEach(() => stubBridge(undefined));

describe("CloudSyncSection", () => {
  it("renders nothing outside the desktop shell", () => {
    const { container } = render(<CloudSyncSection />);
    expect(container).toBeEmptyDOMElement();
  });

  it("lets a signed-out cloud profile start a fresh sign-in", async () => {
    const signIn = vi.fn().mockResolvedValue({
      mode: "cloud", connecting: false, state: "idle",
      lastSyncAt: "2026-09-26T23:00:00.000Z", pending: 0, conflicts: 0,
    });
    stubBridge({
      status: vi.fn().mockResolvedValue({
        mode: "cloud", connecting: false, state: "auth_required",
        lastSyncAt: null, pending: 0, conflicts: 0,
      }),
      signIn,
      syncNow: vi.fn(),
    });

    render(<CloudSyncSection />);
    expect(await screen.findByText("Signed out")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(signIn).toHaveBeenCalledOnce();
    expect(await screen.findByText("Synced")).toBeInTheDocument();
  });

  it("offers manual sync and shows when pending changes clear", async () => {
    const syncNow = vi.fn().mockResolvedValue({
      mode: "cloud", connecting: false, state: "idle",
      lastSyncAt: "2026-09-26T23:00:00.000Z", pending: 0, conflicts: 0,
    });
    stubBridge({
      status: vi.fn().mockResolvedValue({
        mode: "cloud", connecting: false, state: "idle",
        lastSyncAt: "2026-09-26T22:00:00.000Z", pending: 2, conflicts: 0,
      }),
      signIn: vi.fn(),
      syncNow,
    });

    render(<CloudSyncSection />);
    expect(await screen.findByText(/2 changes waiting to sync/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Sync now" }));
    expect(syncNow).toHaveBeenCalledOnce();
    expect(await screen.findByText(/All changes synced/)).toBeInTheDocument();
  });
});
