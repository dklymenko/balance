import { describe, expect, it } from "vitest";
import {
  ArchiveError,
  computeBalance,
  computeBalanceUsd,
  contribution,
  dedupeRows,
  isStorableCents,
  MAX_CENTS,
  parseAmountToCents,
  validateArchive,
} from "../src/index";

describe("money and balances", () => {
  it("parses locale-shaped amounts into integer cents", () => {
    expect(parseAmountToCents("$1,234.56")).toBe(123456);
    expect(parseAmountToCents("1.234,56")).toBe(123456);
    expect(parseAmountToCents("0")).toBeNull();
    expect(parseAmountToCents("not money")).toBeNull();
  });

  it("recomputes transfers and adjustments without order-dependent deltas", () => {
    const rows = [
      { type: "credit" as const, amount_fx: 10_000, transfer_direction: null },
      { type: "debit" as const, amount_fx: 2_500, transfer_direction: null },
      { type: "transfer" as const, amount_fx: 1_000, transfer_direction: "out" as const },
      { type: "transfer" as const, amount_fx: 750, transfer_direction: "in" as const },
    ];
    expect(rows.map(contribution)).toEqual([10_000, -2_500, -1_000, 750]);
    expect(computeBalance(rows, [{ old_balance: 7_250, new_balance: 8_000 }])).toBe(8_000);
    expect(computeBalanceUsd(8_000, 1.25)).toBe(10_000);
  });

  it("refuses derived balances that cannot be stored as exact cents", () => {
    expect(() => computeBalance([
      { type: "credit", amount_fx: MAX_CENTS, transfer_direction: null },
      { type: "credit", amount_fx: 1, transfer_direction: null },
    ], [])).toThrow(/supported money range/);
    expect(() => computeBalanceUsd(MAX_CENTS, 2)).toThrow(/supported money range/);
  });

  it("sums in exact, order-independent arithmetic before checking the final bound", () => {
    const rows = [
      { type: "credit" as const, amount_fx: MAX_CENTS, transfer_direction: null },
      { type: "credit" as const, amount_fx: MAX_CENTS, transfer_direction: null },
      { type: "debit" as const, amount_fx: MAX_CENTS, transfer_direction: null },
    ];
    expect(computeBalance(rows, [])).toBe(MAX_CENTS);
    expect(computeBalance([...rows].reverse(), [])).toBe(MAX_CENTS);
  });
});

describe("archive validation", () => {
  const minimal = {
    format: "balance-archive",
    version: 1,
    exported_at: "2026-08-23T00:00:00.000Z",
    accounts: [{
      id: 1, name: "Synthetic Checking", account_type: "Checking",
      base_currency: "USD", liquidity_type: "Liquid", balance: 100,
      exchange_rate: 1, balance_usd: 100,
    }],
    categories: [], tags: [], transactions: [], account_adjustments: [], transaction_tags: [],
  };

  it("accepts a bounded, referentially valid archive", () => {
    expect(validateArchive(minimal).accounts[0].name).toBe("Synthetic Checking");
  });

  it("rejects malformed or duplicate stable identities", () => {
    expect(() => validateArchive({
      ...minimal,
      accounts: [{ ...minimal.accounts[0], uuid: "" }],
    })).toThrow(/uuid/i);
    expect(() => validateArchive({
      ...minimal,
      accounts: [
        { ...minimal.accounts[0], uuid: "same-identity" },
        { ...minimal.accounts[0], id: 2, name: "Synthetic Savings", uuid: "same-identity" },
      ],
    })).toThrow(/uuid.*unique/i);
  });

  it("rejects dangling references and fractional cents", () => {
    expect(() => validateArchive({
      ...minimal,
      transactions: [{
        id: 1, account_id: 99, category_id: null, date: "2026-08-23",
        description: "Synthetic", amount_fx: 1.5, amount_usd: 1.5,
        exchange_rate: 1, type: "debit", exclude_from_reports: false,
      }],
    })).toThrow(ArchiveError);
  });

  it("rejects invalid dates, duplicate ids, oversized money, and nested category chains", () => {
    expect(() => validateArchive({
      ...minimal,
      transactions: [{
        id: 1, account_id: 1, category_id: null, date: "2026-02-30",
        description: "Synthetic", amount_fx: 100, amount_usd: 100,
        exchange_rate: 1, type: "debit", exclude_from_reports: false,
      }],
    })).toThrow(/real calendar date/);

    expect(() => validateArchive({ ...minimal, accounts: [minimal.accounts[0], minimal.accounts[0]] }))
      .toThrow(/unique/);
    expect(() => validateArchive({
      ...minimal,
      accounts: [{ ...minimal.accounts[0], balance: 100_000_000_000_001 }],
    })).toThrow(/integer cents/);
    expect(() => validateArchive({
      ...minimal,
      categories: [
        { id: 1, name: "One", parent_id: null },
        { id: 2, name: "Two", parent_id: 1 },
        { id: 3, name: "Three", parent_id: 2 },
      ],
    })).toThrow(/at most one level/);
  });

  it("requires transfers to be complete two-leg groups and upgrades legacy directions", () => {
    const accounts = [minimal.accounts[0], { ...minimal.accounts[0], id: 2, name: "Synthetic Savings" }];
    const leg = {
      account_id: 1, category_id: null, date: "2026-08-23", description: "Synthetic move",
      amount_fx: 100, amount_usd: 100, exchange_rate: 1, type: "transfer", exclude_from_reports: false,
      transfer_group_id: "group-1", transfer_direction: null,
    };
    expect(() => validateArchive({ ...minimal, accounts, transactions: [{ ...leg, id: 1 }] }))
      .toThrow(/exactly two legs/);

    const restored = validateArchive({
      ...minimal,
      accounts,
      transactions: [{ ...leg, id: 10 }, { ...leg, id: 11, account_id: 2 }],
    });
    expect(restored.transactions.map((row) => row.transfer_direction)).toEqual(["out", "in"]);
  });

  it("rejects transfer metadata on ordinary transactions", () => {
    expect(() => validateArchive({
      ...minimal,
      transactions: [{
        id: 1, account_id: 1, category_id: null, date: "2026-08-23", description: "Synthetic",
        amount_fx: 100, amount_usd: 100, exchange_rate: 1, type: "debit",
        transfer_group_id: "not-a-transfer", transfer_direction: "out", exclude_from_reports: false,
      }],
    })).toThrow(/transfer metadata/);
  });

  it("rejects non-positive or internally inconsistent transaction money", () => {
    const row = {
      id: 1, account_id: 1, category_id: null, date: "2026-08-23", description: "Synthetic",
      amount_fx: 100, amount_usd: 125, exchange_rate: 1, type: "debit",
      transfer_group_id: null, transfer_direction: null, exclude_from_reports: false,
    };
    expect(() => validateArchive({ ...minimal, transactions: [{ ...row, amount_fx: 0 }] }))
      .toThrow(/positive/);
    expect(() => validateArchive({ ...minimal, transactions: [row] }))
      .toThrow(/amount_usd/);
  });

  it("rejects transfer legs that disagree on their USD value", () => {
    const accounts = [minimal.accounts[0], { ...minimal.accounts[0], id: 2, name: "Savings" }];
    const leg = {
      account_id: 1, category_id: null, date: "2026-08-23", description: "Move",
      amount_fx: 100, amount_usd: 100, exchange_rate: 1, type: "transfer",
      transfer_group_id: "group-1", exclude_from_reports: false,
    };
    expect(() => validateArchive({
      ...minimal,
      accounts,
      transactions: [
        { ...leg, id: 1, transfer_direction: "out" },
        { ...leg, id: 2, account_id: 2, amount_usd: 99, transfer_direction: "in" },
      ],
    })).toThrow(/same amount_usd/);
  });

  it("rejects negative or unrepresentable RSU market values", () => {
    expect(() => validateArchive({
      ...minimal,
      accounts: [{
        ...minimal.accounts[0], account_type: "RSU", shares_quantity: 1,
        current_price_usd: -1,
      }],
    })).toThrow(/current_price_usd/);
    expect(() => validateArchive({
      ...minimal,
      accounts: [{
        ...minimal.accounts[0], account_type: "RSU", shares_quantity: 1_000_000_000,
        current_price_usd: MAX_CENTS,
      }],
    })).toThrow(/market value/);
  });
});

describe("import deduplication", () => {
  it("drops same-amount rows inside the configured date window", () => {
    const incoming = [
      { date: "2026-08-20", amount_cents: 500, memo: "duplicate" },
      { date: "2026-08-10", amount_cents: 500, memo: "outside window" },
    ];
    expect(dedupeRows(incoming, [{ date: "2026-08-22", amount_cents: 500 }], 3)).toEqual({
      rows: [incoming[1]], skipped: 1,
    });
  });
});

describe("storable cents bound", () => {
  it("accepts exact integer cents and rejects anything past the safe range", () => {
    expect(isStorableCents(0)).toBe(true);
    expect(isStorableCents(-MAX_CENTS)).toBe(true);
    expect(isStorableCents(MAX_CENTS)).toBe(true);
    expect(isStorableCents(MAX_CENTS + 1)).toBe(false);
    // Past 2^53 a JS number is no longer an exact integer, which is what makes
    // SQLite store it as a float in an integer column.
    expect(isStorableCents(1e23)).toBe(false);
    expect(isStorableCents(Number.MAX_SAFE_INTEGER + 2)).toBe(false);
    expect(isStorableCents(1.5)).toBe(false);
    expect(isStorableCents(NaN)).toBe(false);
    expect(isStorableCents(Infinity)).toBe(false);
    expect(isStorableCents("100")).toBe(false);
  });

  it("is the same bound the archive validator enforces", () => {
    const archive = (amount: number) => ({
      format: "balance-archive", version: 1, exported_at: "2026-01-01T00:00:00.000Z",
      accounts: [{
        id: 1, name: "A", account_type: "Checking", liquidity_type: "Liquid",
        balance: 0, balance_usd: 0, exchange_rate: 1, base_currency: "USD",
        ticker: null, shares_quantity: null, current_price_usd: null, sort_order: null,
        notes: null, is_default: false, is_active: true, exclude_from_reports: false,
      }],
      categories: [], tags: [], account_adjustments: [], transaction_tags: [],
      transactions: [{
        id: 1, account_id: 1, category_id: null, date: "2026-01-01", description: "",
        amount_fx: amount, amount_usd: amount, exchange_rate: 1, type: "debit",
        transfer_group_id: null, transfer_direction: null, exclude_from_reports: false,
      }],
    });
    expect(validateArchive(archive(MAX_CENTS)).transactions[0].amount_usd).toBe(MAX_CENTS);
    expect(() => validateArchive(archive(MAX_CENTS + 1))).toThrow(/integer cents/);
  });
});
