import { describe, it, expect } from "vitest";
import { scrapeWindowFor } from "@/lib/desktopBridge";

describe("scrapeWindowFor", () => {
  it("returns null for an empty date list", () => {
    expect(scrapeWindowFor([])).toBeNull();
  });

  // Mirrors the server's window rule (imports.ts): newest = max(date),
  // oldest = min(date) - 90 days. Same fixture as the server-side
  // "computes scrape window" integration test.
  it("computes newest = max(date), oldest = min(date) - 90d", () => {
    const w = scrapeWindowFor(["2026-04-10", "2026-04-25", "2026-04-15"]);
    expect(w).toEqual({ oldestIso: "2026-01-10", newestIso: "2026-04-25" });
  });

  it("handles a single date", () => {
    const w = scrapeWindowFor(["2026-03-01"]);
    expect(w).toEqual({ oldestIso: "2025-12-01", newestIso: "2026-03-01" });
  });
});
