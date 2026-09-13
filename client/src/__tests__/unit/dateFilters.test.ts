import { describe, it, expect } from "vitest";
import { isWithinLast24h } from "../../lib/dateFilters";

describe("isWithinLast24h", () => {
  const now = new Date("2026-05-16T12:00:00Z").getTime();

  it("returns true for a timestamp 1 hour ago", () => {
    expect(isWithinLast24h("2026-05-16T11:00:00Z", now)).toBe(true);
  });

  it("returns true for a timestamp 23h 59m ago", () => {
    expect(isWithinLast24h("2026-05-15T12:00:01Z", now)).toBe(true);
  });

  it("returns false for a timestamp 24h 1s ago", () => {
    expect(isWithinLast24h("2026-05-15T11:59:59Z", now)).toBe(false);
  });

  it("returns false for a timestamp 3 days ago", () => {
    expect(isWithinLast24h("2026-05-13T12:00:00Z", now)).toBe(false);
  });

  it("returns false for a future timestamp (clock skew)", () => {
    expect(isWithinLast24h("2026-05-16T12:00:01Z", now)).toBe(false);
  });

  it("returns false for an empty or invalid string", () => {
    expect(isWithinLast24h("", now)).toBe(false);
    expect(isWithinLast24h("not-a-date", now)).toBe(false);
  });
});
