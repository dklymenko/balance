import { randomUUID } from "node:crypto";
import type { DrizzleDB } from "../db/types.js";
import { runTransaction } from "../db/tx.js";
import {
  accounts, accountAdjustments, categories, transactions,
  type AccountType, type LiquidityType, type CategoryKind, type TransactionType,
} from "../db/schema.js";
import { recomputeAccounts } from "./recompute.js";
import { recordChange } from "./ledgerHooks.js";

// Synthetic sample data for evaluating account, transaction, transfer,
// reporting, multi-currency, and equity-holding workflows. All names and values
// are fictional.
//
// Generation is deterministic relative to "today" (no randomness): fixed
// days-of-month for bills/salary/transfers, fixed weekdays for groceries/
// dining/transit, cycling through small amount/merchant lists so reports look
// alive. All money is integer cents in the account's native currency.

interface SampleAccountDef {
  name: string;
  account_type: AccountType;
  liquidity_type: LiquidityType;
  base_currency: string;
  exchange_rate: number;
  opening: number; // native cents
  ticker?: string;
  shares_quantity?: number;
  current_price_usd?: number; // cents
}

export const SAMPLE_ACCOUNT_DEFS: SampleAccountDef[] = [
  { name: "Everyday Checking", account_type: "Checking", liquidity_type: "Liquid", base_currency: "USD", exchange_rate: 1, opening: 320000 },
  { name: "Household Savings", account_type: "Savings", liquidity_type: "Liquid", base_currency: "USD", exchange_rate: 1, opening: 1250000 },
  { name: "Sapphire Card", account_type: "CC", liquidity_type: "Liquid", base_currency: "USD", exchange_rate: 1, opening: -84000 },
  { name: "Euro Account", account_type: "Checking", liquidity_type: "Liquid", base_currency: "EUR", exchange_rate: 1.08, opening: 200000 },
  { name: "TechCo RSUs", account_type: "RSU", liquidity_type: "Invested", base_currency: "USD", exchange_rate: 1, opening: 0, ticker: "TCO", shares_quantity: 120, current_price_usd: 5240 },
  { name: "Retirement 401k", account_type: "401k", liquidity_type: "Locked", base_currency: "USD", exchange_rate: 1, opening: 3800000 },
];

const SAMPLE_CATEGORIES: { name: string; kind?: CategoryKind; children?: string[] }[] = [
  { name: "Salary", kind: "income" },
  { name: "Other Income", kind: "income" },
  { name: "Housing", children: ["Rent", "Utilities"] },
  { name: "Food", children: ["Groceries", "Dining Out"] },
  { name: "Transport" },
  { name: "Subscriptions" },
  { name: "Shopping" },
  { name: "Health" },
  { name: "Travel" },
];

interface SampleTx {
  date: string;
  account: string; // SAMPLE_ACCOUNT_DEFS name
  category: string | null;
  description: string;
  amount: number; // native cents
  type: TransactionType;
  toAccount?: string; // transfer counterparty
}

const HISTORY_DAYS = 90;

const cycle = <T,>(arr: T[], i: number): T => arr[i % arr.length];

// The ~3 months of ledger history, oldest first (so ids ascend chronologically
// and each transfer's from-leg gets the lower id, matching the pairing rule).
function generateTransactions(): SampleTx[] {
  const todayUtc = new Date();
  const rows: SampleTx[] = [];
  let groceriesN = 0, diningN = 0, utilitiesN = 0;

  for (let offset = HISTORY_DAYS; offset >= 0; offset--) {
    const d = new Date(todayUtc);
    d.setUTCDate(d.getUTCDate() - offset);
    const date = d.toISOString().slice(0, 10);
    const dayOfMonth = d.getUTCDate();
    const weekday = d.getUTCDay();

    if (dayOfMonth === 1) {
      rows.push({ date, account: "Everyday Checking", category: "Salary", description: "TechCo payroll", amount: 420000, type: "credit" });
      rows.push({ date, account: "Everyday Checking", category: "Rent", description: "Apartment rent", amount: 235000, type: "debit" });
    }
    if (dayOfMonth === 15) {
      rows.push({ date, account: "Everyday Checking", category: "Salary", description: "TechCo payroll", amount: 420000, type: "credit" });
    }
    if (dayOfMonth === 2) {
      rows.push({ date, account: "Everyday Checking", category: null, description: "Monthly savings", amount: 50000, type: "transfer", toAccount: "Household Savings" });
    }
    if (dayOfMonth === 5) {
      rows.push({ date, account: "Everyday Checking", category: "Utilities", description: "City Power & Water", amount: cycle([14250, 15830, 13990], utilitiesN++), type: "debit" });
    }
    if (dayOfMonth === 3) rows.push({ date, account: "Sapphire Card", category: "Subscriptions", description: "Streamly", amount: 1599, type: "debit" });
    if (dayOfMonth === 9) rows.push({ date, account: "Sapphire Card", category: "Subscriptions", description: "MusicNow", amount: 1099, type: "debit" });
    if (dayOfMonth === 12) rows.push({ date, account: "Sapphire Card", category: "Subscriptions", description: "CloudBox", amount: 299, type: "debit" });
    if (dayOfMonth === 20) {
      rows.push({ date, account: "Everyday Checking", category: null, description: "Card payment", amount: 85000, type: "transfer", toAccount: "Sapphire Card" });
    }
    if (dayOfMonth === 8) {
      rows.push({ date, account: "Euro Account", category: "Subscriptions", description: "EU mobile plan", amount: 4500, type: "debit" });
    }

    if (weekday === 6) {
      rows.push({ date, account: "Sapphire Card", category: "Groceries", description: cycle(["FreshMart", "Whole Grains Market"], groceriesN), amount: cycle([8640, 12375, 9710, 14520], groceriesN), type: "debit" });
      groceriesN++;
    }
    if (weekday === 5) {
      rows.push({ date, account: "Sapphire Card", category: "Dining Out", description: cycle(["Nori Sushi", "La Taqueria", "Trattoria Nonna"], diningN), amount: cycle([4230, 2780, 6540], diningN), type: "debit" });
      diningN++;
    }
    if (weekday === 1) rows.push({ date, account: "Sapphire Card", category: "Dining Out", description: "Corner Cafe", amount: 875, type: "debit" });
    if (weekday === 3) rows.push({ date, account: "Sapphire Card", category: "Transport", description: "CityRide", amount: 3200, type: "debit" });

    // One-off color, anchored to fixed offsets.
    if (offset === 60) rows.push({ date, account: "Everyday Checking", category: "Other Income", description: "Marketplace sale", amount: 25000, type: "credit" });
    if (offset === 44) rows.push({ date, account: "Sapphire Card", category: "Travel", description: "Atlantic Air -- Lisbon", amount: 48600, type: "debit" });
    if (offset === 41) rows.push({ date, account: "Sapphire Card", category: "Travel", description: "Hotel Lisboa", amount: 39240, type: "debit" });
    if (offset === 38) rows.push({ date, account: "Euro Account", category: "Dining Out", description: "Time Out Market", amount: 5320, type: "debit" });
    if (offset === 25) rows.push({ date, account: "Sapphire Card", category: "Shopping", description: "Nordic Home Store", amount: 12999, type: "debit" });
    if (offset === 18) rows.push({ date, account: "Everyday Checking", category: "Health", description: "GreenLeaf Pharmacy", amount: 4500, type: "debit" });
    if (offset === 10) rows.push({ date, account: "Sapphire Card", category: "Shopping", description: "BookNook", amount: 4599, type: "debit" });
  }

  return rows;
}

export async function seedSampleData(db: DrizzleDB): Promise<{ accounts: number; categories: number; transactions: number }> {
  const txDefs = generateTransactions();

  let categoryCount = 0;
  let txCount = 0;

  await runTransaction(db, async (tx) => {
    const existing = await tx.select({ id: accounts.id }).from(accounts).limit(1);
    if (existing.length > 0) {
      throw Object.assign(
        new Error("Sample data can only be loaded into an empty household."),
        { status: 400 },
      );
    }
    const accountIdByName = new Map<string, number>();
    const accountUuids: string[] = [];
    const adjustmentUuids: string[] = [];
    for (const def of SAMPLE_ACCOUNT_DEFS) {
      const [row] = await tx.insert(accounts).values({
        name: def.name,
        account_type: def.account_type,
        liquidity_type: def.liquidity_type,
        base_currency: def.base_currency,
        exchange_rate: def.exchange_rate,
        balance: 0,
        balance_usd: 0,
        ticker: def.ticker ?? null,
        shares_quantity: def.shares_quantity ?? null,
        current_price_usd: def.current_price_usd ?? null,
      }).returning({ id: accounts.id, uuid: accounts.uuid });
      accountIdByName.set(def.name, row.id);
      accountUuids.push(row.uuid);
      if (def.opening !== 0) {
        const [adjustment] = await tx.insert(accountAdjustments).values({
          account_id: row.id,
          old_balance: 0,
          new_balance: def.opening,
          reason: "Opening balance (sample data)",
        }).returning({ uuid: accountAdjustments.uuid });
        adjustmentUuids.push(adjustment.uuid);
      }
    }

    const categoryIdByName = new Map<string, number>();
    const categoryUuids: string[] = [];
    for (const def of SAMPLE_CATEGORIES) {
      const [parent] = await tx.insert(categories).values({
         name: def.name, parent_id: null, kind: def.kind ?? "expense",
      }).returning({ id: categories.id, uuid: categories.uuid });
      categoryIdByName.set(def.name, parent.id);
      categoryUuids.push(parent.uuid);
      categoryCount++;
      for (const child of def.children ?? []) {
        const [c] = await tx.insert(categories).values({
           name: child, parent_id: parent.id, kind: "expense",
        }).returning({ id: categories.id, uuid: categories.uuid });
        categoryIdByName.set(child, c.id);
        categoryUuids.push(c.uuid);
        categoryCount++;
      }
    }

    const rate = (name: string) => SAMPLE_ACCOUNT_DEFS.find((a) => a.name === name)!.exchange_rate;
    const values: (typeof transactions.$inferInsert)[] = [];
    for (const t of txDefs) {
      const legs = t.type === "transfer"
        ? [{ account: t.account, direction: "out" as const }, { account: t.toAccount!, direction: "in" as const }]
        : [{ account: t.account, direction: null }];
      const groupId = t.type === "transfer" ? randomUUID() : null;
      for (const leg of legs) {
        values.push({
          account_id: accountIdByName.get(leg.account)!,
          category_id: t.category ? categoryIdByName.get(t.category)! : null,
          date: t.date,
          description: t.description,
          amount_fx: t.amount,
          exchange_rate: rate(leg.account),
          amount_usd: Math.round(t.amount * rate(leg.account)),
          type: t.type,
          transfer_group_id: groupId,
          transfer_direction: leg.direction,
        });
      }
    }
    const insertedTransactions = await tx.insert(transactions).values(values)
      .returning({ uuid: transactions.uuid });
    recomputeAccounts(tx, accountIdByName.values());
    for (const uuid of accountUuids) recordChange({ entity: "account", entityUuid: uuid, op: "upsert" });
    for (const uuid of categoryUuids) recordChange({ entity: "category", entityUuid: uuid, op: "upsert" });
    for (const row of insertedTransactions) recordChange({ entity: "transaction", entityUuid: row.uuid, op: "upsert" });
    for (const uuid of adjustmentUuids) recordChange({ entity: "account_adjustment", entityUuid: uuid, op: "upsert" });
    txCount = values.length;
  });

  return { accounts: SAMPLE_ACCOUNT_DEFS.length, categories: categoryCount, transactions: txCount };
}
