import { describe, it, expect } from "vitest";
import { dedupeRows } from "../../lib/dedupe.js";
import type { ParsedRow } from "../../lib/csvParsers.js";

function row(date: string, amount: string): ParsedRow {
  return { date, amount, description: "test", type: "debit" };
}

function existing(date: string, amount_usd: number, description = "test", type: "debit" | "credit" = "debit") {
  return { date, amount_usd, description, type };
}

describe("dedupeRows -- no window (exact match)", () => {
  it("removes exact duplicate", () => {
    const { rows, skipped } = dedupeRows([row("2025-01-15", "50")], [existing("2025-01-15", 50)], 0);
    expect(rows).toHaveLength(0);
    expect(skipped).toBe(1);
  });

  it("keeps row with different amount", () => {
    const { rows } = dedupeRows([row("2025-01-15", "50")], [existing("2025-01-15", 100)], 0);
    expect(rows).toHaveLength(1);
  });

  it("keeps row when date differs by 1 day with no window", () => {
    const { rows } = dedupeRows([row("2025-01-15", "50")], [existing("2025-01-16", 50)], 0);
    expect(rows).toHaveLength(1);
  });
});

describe("dedupeRows -- 3-day window", () => {
  it("dedupes when existing date is 1 day after incoming", () => {
    const { rows, skipped } = dedupeRows([row("2025-01-15", "50")], [existing("2025-01-16", 50)], 3);
    expect(rows).toHaveLength(0);
    expect(skipped).toBe(1);
  });

  it("dedupes when existing date is 3 days before incoming", () => {
    const { rows } = dedupeRows([row("2025-01-18", "50")], [existing("2025-01-15", 50)], 3);
    expect(rows).toHaveLength(0);
  });

  it("keeps row when date differs by 4 days", () => {
    const { rows } = dedupeRows([row("2025-01-19", "50")], [existing("2025-01-15", 50)], 3);
    expect(rows).toHaveLength(1);
  });

  it("dedupes multiple matching rows", () => {
    const incoming = [row("2025-01-15", "50"), row("2025-01-20", "100")];
    const exist = [existing("2025-01-16", 50), existing("2025-01-21", 100)];
    const { rows, skipped } = dedupeRows(incoming, exist, 3);
    expect(rows).toHaveLength(0);
    expect(skipped).toBe(2);
  });

  it("keeps rows with no match in existing", () => {
    const { rows } = dedupeRows([row("2025-01-15", "50")], [], 3);
    expect(rows).toHaveLength(1);
  });
});

describe("dedupeRows -- float precision", () => {
  it("treats 91.56 and 91.56 as equal despite float representation", () => {
    const { rows } = dedupeRows([row("2025-01-15", "91.56")], [existing("2025-01-15", 91.56)], 0);
    expect(rows).toHaveLength(0);
  });
});

describe("dedupeRows -- safe identity", () => {
  it("keeps different merchants with the same date and amount", () => {
    const incoming = [{ ...row("2025-01-15", "50"), description: "Coffee shop" }];
    const { rows } = dedupeRows(incoming, [existing("2025-01-15", 50, "Groceries")], 0);
    expect(rows).toHaveLength(1);
  });

  it("removes repeated rows inside the same imported file", () => {
    const duplicate = row("2025-01-15", "50");
    const { rows, skipped } = dedupeRows([duplicate, { ...duplicate }], [], 0);
    expect(rows).toHaveLength(1);
    expect(skipped).toBe(1);
  });

  it("keeps a credit that otherwise matches a debit", () => {
    const incoming = [{ ...row("2025-01-15", "50"), type: "credit" as const }];
    const { rows } = dedupeRows(incoming, [existing("2025-01-15", 50)], 0);
    expect(rows).toHaveLength(1);
  });
});
