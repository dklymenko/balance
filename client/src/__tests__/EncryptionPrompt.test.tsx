import { describe, expect, it, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import EncryptionPrompt from "@/components/EncryptionPrompt";
import type { EncryptionStatus } from "@/lib/desktopBridge";

// At-rest encryption is opt-in, so this card is the moment the app first asks
// for the macOS Keychain. It must not appear before there is a ledger worth
// protecting, must say plainly that a permission prompt is coming, and must
// stay gone once the user declines.

const status = (over: Partial<EncryptionStatus> = {}): EncryptionStatus =>
  ({ encrypted: false, declined: false, ...over });

function installBridge(over: Partial<EncryptionStatus> = {}, enable?: () => Promise<unknown>) {
  const current = status(over);
  const bridge = {
    scrapeAmazon: vi.fn(),
    encryption: {
      status: vi.fn().mockResolvedValue(current),
      enable: vi.fn(enable ?? (async () => ({ ok: true, status: status({ encrypted: true }) }))),
      decline: vi.fn().mockResolvedValue(status({ declined: true })),
    },
  };
  (window as unknown as { balanceDesktop?: unknown }).balanceDesktop = bridge;
  return bridge;
}

beforeEach(() => {
  localStorage.clear();
  // The card waits for the getting-started checklist to be finished
  // (lib/onboarding.ts REPORT_VIEWED_KEY).
  localStorage.setItem("balance-report-viewed", "1");
  delete (window as unknown as { balanceDesktop?: unknown }).balanceDesktop;
});

describe("EncryptionPrompt", () => {
  it("offers encryption and warns that macOS will ask for permission", async () => {
    installBridge();
    render(<EncryptionPrompt hasLedgerData />);
    expect(await screen.findByRole("button", { name: /encrypt my ledger/i })).toBeInTheDocument();
    // The whole point of the card: the Keychain prompt must not be a surprise.
    expect(screen.getByText(/macOS will ask for permission/i)).toBeInTheDocument();
    expect(screen.getByText(/Always Allow/)).toBeInTheDocument();
  });

  it("stays hidden until there is a ledger to protect", async () => {
    installBridge();
    const { container } = render(<EncryptionPrompt hasLedgerData={false} />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it("stays hidden while the getting-started checklist is unfinished", async () => {
    localStorage.clear();
    installBridge();
    const { container } = render(<EncryptionPrompt hasLedgerData />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it("stays hidden when already encrypted or previously declined", async () => {
    for (const over of [{ encrypted: true }, { declined: true }]) {
      installBridge(over);
      const { container, unmount } = render(<EncryptionPrompt hasLedgerData />);
      await waitFor(() => expect(container).toBeEmptyDOMElement());
      unmount();
    }
  });

  it("stays hidden outside the desktop shell", async () => {
    const { container } = render(<EncryptionPrompt hasLedgerData />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it("disappears once encryption succeeds", async () => {
    installBridge();
    render(<EncryptionPrompt hasLedgerData />);
    await userEvent.click(await screen.findByRole("button", { name: /encrypt my ledger/i }));
    await waitFor(() => expect(screen.queryByRole("button", { name: /encrypt my ledger/i })).toBeNull());
  });

  it("surfaces a failure without claiming success", async () => {
    installBridge({}, async () => ({ ok: false, error: "Keychain unavailable", status: status() }));
    render(<EncryptionPrompt hasLedgerData />);
    await userEvent.click(await screen.findByRole("button", { name: /encrypt my ledger/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Keychain unavailable");
    // Still offered, because nothing was encrypted.
    expect(screen.getByRole("button", { name: /encrypt my ledger/i })).toBeInTheDocument();
  });

  it("records a decline so the offer does not come back", async () => {
    const bridge = installBridge();
    render(<EncryptionPrompt hasLedgerData />);
    await userEvent.click(await screen.findByRole("button", { name: /not now/i }));
    expect(bridge.encryption.decline).toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("button", { name: /not now/i })).toBeNull());
  });
});
