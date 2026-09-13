import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import AppLockSection from "@/components/AppLockSection";
import type { DesktopAppLock } from "@/lib/desktopBridge";

function stubBridge(lock: Partial<DesktopAppLock> | undefined) {
  (window as unknown as { balanceDesktop?: unknown }).balanceDesktop =
    lock ? { scrapeAmazon: vi.fn(), appLock: lock } : undefined;
}

afterEach(() => stubBridge(undefined));

describe("AppLockSection", () => {
  it("renders nothing outside the desktop shell", () => {
    stubBridge(undefined);
    const { container } = render(<AppLockSection />);
    expect(container).toBeEmptyDOMElement();
  });

  it("offers to enable the lock and reflects the new state", async () => {
    const setup = vi.fn().mockResolvedValue({ enabled: true, touchId: true });
    stubBridge({ status: vi.fn().mockResolvedValue({ enabled: false, touchId: true }), setup });
    render(<AppLockSection />);

    const enable = await screen.findByText("Require password to open…");
    await userEvent.click(enable);
    expect(setup).toHaveBeenCalledOnce();
    expect(await screen.findByText("Lock now")).toBeInTheDocument();
    expect(screen.getByText("Change password…")).toBeInTheDocument();
    expect(screen.getByText("Turn off…")).toBeInTheDocument();
  });

  it("shows management actions when the lock is already on", async () => {
    stubBridge({ status: vi.fn().mockResolvedValue({ enabled: true, touchId: false }) });
    render(<AppLockSection />);
    expect(await screen.findByText("Lock now")).toBeInTheDocument();
    expect(screen.getByText(/asks for a password when it opens/)).toBeInTheDocument();
  });
});
