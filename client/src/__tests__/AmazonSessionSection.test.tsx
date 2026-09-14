import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import AmazonSessionSection from "@/components/AmazonSessionSection";

beforeEach(() => {
  delete (window as unknown as { balanceDesktop?: unknown }).balanceDesktop;
});

describe("AmazonSessionSection", () => {
  it("stays hidden outside the desktop app", () => {
    const { container } = render(<AmazonSessionSection />);
    expect(container).toBeEmptyDOMElement();
  });

  it("explains local encrypted storage and lets the user forget the sign-in", async () => {
    const forget = vi.fn().mockResolvedValue({ forgotten: true });
    (window as unknown as { balanceDesktop?: unknown }).balanceDesktop = {
      scrapeAmazon: vi.fn(),
      amazonSession: { forget },
    };

    render(<AmazonSessionSection />);

    expect(screen.getByText(/cookie values are encrypted/i)).toBeInTheDocument();
    expect(screen.getByText(/never synced to Balance Cloud/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /forget Amazon sign-in/i }));
    expect(forget).toHaveBeenCalledOnce();
    expect(await screen.findByRole("status")).toHaveTextContent("Amazon sign-in removed from this Mac.");
  });
});
