import { describe, it, expect } from "vitest";
import {
  selectableAccounts,
  findDefaultAccountId,
  type Account,
} from "@/components/TransactionForm";
import { visibleAccounts } from "@/lib/accountVisibility";

function acc(partial: Partial<Account> & { id: number; name: string }): Account {
  return {
    base_currency: "USD",
    account_type: "Checking",
    liquidity_type: "Liquid",
    ...partial,
  };
}

describe("selectableAccounts", () => {
  it("excludes inactive accounts from the new-transaction picker", () => {
    const accounts = [
      acc({ id: 1, name: "Active" }),
      acc({ id: 2, name: "Legacy", is_active: false }),
      acc({ id: 3, name: "Also active", is_active: true }),
    ];
    expect(selectableAccounts(accounts).map((a) => a.name)).toEqual(["Active", "Also active"]);
  });

  it("treats a missing is_active as active (back-compat)", () => {
    const accounts = [acc({ id: 1, name: "NoFlag" })];
    expect(selectableAccounts(accounts)).toHaveLength(1);
  });
});

describe("visibleAccounts (Transactions/Reports picker sidebars)", () => {
  it("hides legacy/inactive accounts from the picker", () => {
    const accounts = [
      acc({ id: 1, name: "Active" }),
      acc({ id: 2, name: "Chase (legacy)", is_active: false }),
      acc({ id: 3, name: "Also active", is_active: true }),
    ];
    expect(visibleAccounts(accounts).map((a) => a.name)).toEqual(["Active", "Also active"]);
  });

  it("treats a missing is_active as active (back-compat)", () => {
    const accounts = [acc({ id: 1, name: "NoFlag" })];
    expect(visibleAccounts(accounts)).toHaveLength(1);
  });
});

describe("findDefaultAccountId", () => {
  it("skips an inactive account even if it is flagged default", () => {
    const accounts = [
      acc({ id: 1, name: "Legacy default", is_default: true, is_active: false }),
      acc({ id: 2, name: "Active" }),
    ];
    // The inactive default must not be chosen -- fall through to the first selectable.
    expect(findDefaultAccountId(accounts)).toBe("2");
  });

  it("returns the active default when present", () => {
    const accounts = [
      acc({ id: 1, name: "Active" }),
      acc({ id: 2, name: "Default", is_default: true }),
    ];
    expect(findDefaultAccountId(accounts)).toBe("2");
  });

  it("returns empty string when no selectable accounts exist", () => {
    const accounts = [acc({ id: 1, name: "Legacy", is_active: false })];
    expect(findDefaultAccountId(accounts)).toBe("");
  });
});
