import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import {
  accounts, accountAdjustments, categories, syncConflicts, syncOutbox, syncState,
  tags, transactions, transactionTags,
} from "../src/schema";
import type { DB } from "../src/types";
import type { SyncApi } from "../src/api";
import {
  completeSnapshot, enrollWithLocalData, recoverInterruptedEnrollment, replaceLocalWithCloud,
} from "../src/enroll";
import { enqueueOps, outboxCount } from "../src/outbox";
import { getSyncMode, setSyncValue } from "../src/state";
import { applyPullPage } from "../src/apply";
import { SyncEngine } from "../src/engine";
import { MAX_CENTS } from "@balance/core";

function makeDb(): { db: DB; sqlite: Database.Database } {
  const sqlite = new Database(":memory:");
  for (const migration of ["0000_normal_santa_claus.sql", "0001_tricky_maginty.sql"]) {
    const sql = readFileSync(new URL(`../../../server/src/migrations/${migration}`, import.meta.url), "utf8");
    for (const statement of sql.split("--> statement-breakpoint")) {
      if (statement.trim()) sqlite.exec(statement);
    }
  }
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, {
    schema: { accounts, accountAdjustments, categories, syncConflicts, syncOutbox, syncState, tags, transactions, transactionTags },
  }) as unknown as DB;
  return { db, sqlite };
}

function localAccount(db: DB, uuid = "local-account") {
  db.insert(accounts).values({
    uuid, name: "Local account", account_type: "Checking", base_currency: "USD",
    liquidity_type: "Liquid", balance: 0, exchange_rate: 1, balance_usd: 0,
  }).run();
}

const cloudAccount = {
  uuid: "cloud-account", name: "Cloud account", account_type: "Checking",
  base_currency: "USD", liquidity_type: "Liquid", exchange_rate: 1,
  ticker: null, shares_quantity: null, current_price_usd: null, sort_order: null,
  notes: null, is_default: false, is_active: true, exclude_from_reports: false,
  created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
};

const emptySnapshot = (over: Record<string, unknown> = {}) => ({
  cursor: 7, accounts: [], categories: [], tags: [], transactions: [], account_adjustments: [],
  tx_after: null, has_more_transactions: false, ...over,
});

const cloudTransaction = (over: Record<string, unknown> = {}) => ({
  account_uuid: "cloud-account", category_uuid: null, date: "2026-01-01",
  description: "Synthetic", amount_fx: 100, exchange_rate: 1, type: "credit",
  transfer_group_id: null, transfer_direction: null, exclude_from_reports: false,
  tag_uuids: [], created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z", ...over,
});

describe("crash-safe Cloud enrollment", () => {
  it("bounds the complete paginated snapshot before it reaches local storage", async () => {
    let after = 0;
    const transaction = (uuid: string) => ({ uuid });
    const snapshot = vi.fn(async () => {
      const page = after++;
      return emptySnapshot({
        transactions: Array.from({ length: 1_000 }, (_, i) => transaction(`tx-${page}-${i}`)),
        tx_after: page + 1,
        has_more_transactions: page < 200,
      });
    });

    await expect(completeSnapshot({ snapshot } as unknown as SyncApi))
      .rejects.toThrow(/transactions.*row limit/i);
    expect(snapshot).toHaveBeenCalledTimes(201);
  });

  it("downloads every snapshot page before atomically replacing local data", async () => {
    const { db, sqlite } = makeDb();
    try {
      localAccount(db);
      const snapshot = vi.fn()
        .mockResolvedValueOnce(emptySnapshot({ accounts: [cloudAccount], tx_after: 1, has_more_transactions: true }))
        .mockResolvedValueOnce(emptySnapshot({ tx_after: 2, has_more_transactions: false }));
      await replaceLocalWithCloud(db, { snapshot } as unknown as SyncApi);
      expect(snapshot).toHaveBeenCalledTimes(2);
      expect(db.select().from(accounts).all().map((row) => row.uuid)).toEqual(["cloud-account"]);
      expect(getSyncMode(db)).toBe("cloud");
    } finally { sqlite.close(); }
  });

  it("leaves the entire local ledger untouched when a later snapshot page fails", async () => {
    const { db, sqlite } = makeDb();
    try {
      localAccount(db);
      const snapshot = vi.fn()
        .mockResolvedValueOnce(emptySnapshot({ accounts: [cloudAccount], tx_after: 1, has_more_transactions: true }))
        .mockRejectedValueOnce(new Error("network down"));
      await expect(replaceLocalWithCloud(db, { snapshot } as unknown as SyncApi)).rejects.toThrow("network down");
      expect(db.select().from(accounts).all().map((row) => row.uuid)).toEqual(["local-account"]);
      expect(getSyncMode(db)).toBe("local");
    } finally { sqlite.close(); }
  });

  it("queues edits made while a local archive is uploading", async () => {
    const { db, sqlite } = makeDb();
    try {
      localAccount(db);
      let finish!: (value: { cursor: number }) => void;
      const importArchive = vi.fn(() => new Promise<{ cursor: number }>((resolve) => { finish = resolve; }));
      const enrolling = enrollWithLocalData(db, { importArchive } as unknown as SyncApi);
      await vi.waitFor(() => expect(importArchive).toHaveBeenCalledOnce());
      localAccount(db, "during-upload");
      enqueueOps(db, [{ op_id: "op-1", type: "delete", entity: "account", uuid: "during-upload" }]);
      finish({ cursor: 11 });
      await enrolling;
      expect(getSyncMode(db)).toBe("cloud");
      expect(outboxCount(db)).toBe(1);
    } finally { sqlite.close(); }
  });

  it("recovers an interrupted enrollment to local mode without deleting data", () => {
    const { db, sqlite } = makeDb();
    try {
      localAccount(db);
      setSyncValue(db, "mode", "enrolling");
      enqueueOps(db, [{ op_id: "op-1", type: "delete", entity: "account", uuid: "local-account" }]);
      expect(recoverInterruptedEnrollment(db)).toBe(true);
      expect(getSyncMode(db)).toBe("local");
      // Preserve edits made after the enrollment upload/snapshot began. Their
      // presence prevents an immediate replace using a stale pre-edit backup;
      // the next full upload includes them before starting over.
      expect(outboxCount(db)).toBe(1);
      expect(db.select().from(accounts).all()).toHaveLength(1);
    } finally { sqlite.close(); }
  });

  it("will not replace local data while post-backup edits are pending", async () => {
    const { db, sqlite } = makeDb();
    try {
      localAccount(db);
      setSyncValue(db, "mode", "enrolling");
      enqueueOps(db, [{ op_id: "op-1", type: "delete", entity: "account", uuid: "local-account" }]);
      setSyncValue(db, "mode", "local");
      const snapshot = vi.fn().mockResolvedValue(emptySnapshot({ accounts: [cloudAccount] }));
      await expect(replaceLocalWithCloud(db, { snapshot } as unknown as SyncApi)).rejects.toThrow(/changed/i);
      expect(snapshot).not.toHaveBeenCalled();
      expect(db.select().from(accounts).all().map((row) => row.uuid)).toEqual(["local-account"]);
    } finally { sqlite.close(); }
  });

  it("rejects malformed Cloud entity payloads atomically", () => {
    const { db, sqlite } = makeDb();
    try {
      expect(() => applyPullPage(db, [{
        seq: 1, entity: "account", uuid: "bad-account", op: "upsert", actor: null,
        at: "2026-01-01T00:00:00.000Z", data: { name: "Missing required fields" },
      }], 1)).toThrow(/account payload/);
      expect(db.select().from(accounts).all()).toHaveLength(0);
    } finally { sqlite.close(); }
  });

  it("rejects Cloud transaction products that cannot be stored as exact cents", () => {
    const { db, sqlite } = makeDb();
    try {
      expect(() => applyPullPage(db, [
        { seq: 1, entity: "account", uuid: "cloud-account", op: "upsert", actor: null,
          at: "2026-01-01T00:00:00.000Z", data: cloudAccount },
        { seq: 2, entity: "transaction", uuid: "tx-overflow", op: "upsert", actor: null,
          at: "2026-01-01T00:00:00.000Z", data: cloudTransaction({ amount_fx: MAX_CENTS, exchange_rate: 2 }) },
      ], 2)).toThrow(/transaction payload/);
      expect(db.select().from(accounts).all()).toHaveLength(0);
    } finally { sqlite.close(); }
  });

  it("rejects an aggregate Cloud balance overflow atomically", () => {
    const { db, sqlite } = makeDb();
    try {
      applyPullPage(db, [
        { seq: 1, entity: "account", uuid: "cloud-account", op: "upsert", actor: null,
          at: "2026-01-01T00:00:00.000Z", data: cloudAccount },
        { seq: 2, entity: "transaction", uuid: "tx-max", op: "upsert", actor: null,
          at: "2026-01-01T00:00:00.000Z", data: cloudTransaction({ amount_fx: MAX_CENTS }) },
      ], 2);
      expect(() => applyPullPage(db, [
        { seq: 3, entity: "transaction", uuid: "tx-one-more", op: "upsert", actor: null,
          at: "2026-01-01T00:00:00.000Z", data: cloudTransaction({ amount_fx: 1 }) },
      ], 3)).toThrow(/supported money range/);
      expect(db.select().from(transactions).all()).toHaveLength(1);
      expect(db.select().from(accounts).all()[0].balance).toBe(MAX_CENTS);
    } finally { sqlite.close(); }
  });

  it("rejects an unrepresentable Cloud RSU valuation", () => {
    const { db, sqlite } = makeDb();
    try {
      expect(() => applyPullPage(db, [{
        seq: 1, entity: "account", uuid: "cloud-account", op: "upsert", actor: null,
        at: "2026-01-01T00:00:00.000Z",
        data: { ...cloudAccount, account_type: "RSU", shares_quantity: 1_000_000_000, current_price_usd: MAX_CENTS },
      }], 1)).toThrow(/account payload/);
      expect(db.select().from(accounts).all()).toHaveLength(0);
    } finally { sqlite.close(); }
  });

  it("keeps exactly one default account when Cloud changes conflict", () => {
    const { db, sqlite } = makeDb();
    try {
      applyPullPage(db, [
        { seq: 1, entity: "account", uuid: "default-a", op: "upsert", actor: null,
          at: "2026-01-01T00:00:00.000Z", data: { ...cloudAccount, uuid: "default-a", name: "Default A", is_default: true } },
        { seq: 2, entity: "account", uuid: "default-b", op: "upsert", actor: null,
          at: "2026-01-01T00:00:01.000Z", data: { ...cloudAccount, uuid: "default-b", name: "Default B", is_default: true } },
      ], 2);

      const defaults = db.select({ uuid: accounts.uuid }).from(accounts)
        .where(eq(accounts.is_default, true)).all();
      expect(defaults).toEqual([{ uuid: "default-b" }]);
    } finally { sqlite.close(); }
  });

  it("stops a paginated pull whose cursor does not advance", async () => {
    const { db, sqlite } = makeDb();
    try {
      setSyncValue(db, "mode", "cloud");
      setSyncValue(db, "client_id", "client-1");
      const pull = vi.fn().mockResolvedValue({ cursor: 0, has_more: true, changes: [] });
      const engine = new SyncEngine(db, { pull } as unknown as SyncApi);
      await engine.syncNow({ force: true });
      expect(pull).toHaveBeenCalledOnce();
      expect(engine.getStatus().state).toBe("error");
    } finally { sqlite.close(); }
  });
});
