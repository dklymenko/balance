import { describe, it, expect, vi, afterEach } from "vitest";
import { periodToRange } from "@/pages/Reports";

function mockToday(iso: string) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(iso));
}

afterEach(() => {
  vi.useRealTimers();
});

// Presets include the running month; "Last" is the previous calendar month.
// Date#setMonth overflows late in the month (Oct 31 minus one month is
// "Sep 31" = Oct 1), which made "Last" equal "This month" on the 29th-31st.
describe("periodToRange", () => {
  it("last-month is the previous month on the 31st", () => {
    mockToday("2026-10-31T12:00:00Z");
    expect(periodToRange("this-month")).toEqual({ start: "2026-10", end: "2026-10" });
    expect(periodToRange("last-month")).toEqual({ start: "2026-09", end: "2026-09" });
    expect(periodToRange("3m")).toEqual({ start: "2026-08", end: "2026-10" });
    expect(periodToRange("1y")).toEqual({ start: "2025-11", end: "2026-10" });
  });

  it("last-month is February on March 31st", () => {
    mockToday("2026-03-31T12:00:00Z");
    expect(periodToRange("last-month")).toEqual({ start: "2026-02", end: "2026-02" });
  });

  it("crosses a year boundary in January", () => {
    mockToday("2026-01-15T12:00:00Z");
    expect(periodToRange("last-month")).toEqual({ start: "2025-12", end: "2025-12" });
    expect(periodToRange("6m")).toEqual({ start: "2025-08", end: "2026-01" });
  });
});
