import { describe, expect, it } from "vitest";
import { parseScrapeWindow } from "../scrapeWindow";

describe("parseScrapeWindow", () => {
  it("accepts an ordered inclusive window of real calendar dates", () => {
    expect(parseScrapeWindow({ oldestIso: "2024-02-29", newestIso: "2026-04-25" }))
      .toEqual({ oldestIso: "2024-02-29", newestIso: "2026-04-25" });
    expect(parseScrapeWindow({ oldestIso: "2026-04-25", newestIso: "2026-04-25" }))
      .toEqual({ oldestIso: "2026-04-25", newestIso: "2026-04-25" });
  });

  it("rejects impossible, malformed, or reversed windows", () => {
    for (const value of [
      null,
      {},
      { oldestIso: "2026-02-29", newestIso: "2026-04-25" },
      { oldestIso: "2026-13-01", newestIso: "2026-04-25" },
      { oldestIso: "2026-04-26", newestIso: "2026-04-25" },
      { oldestIso: "04/01/2026", newestIso: "2026-04-25" },
    ]) {
      expect(parseScrapeWindow(value)).toBeNull();
    }
  });
});
