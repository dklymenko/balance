import { describe, expect, it, vi } from "vitest";
import type { DrizzleDB } from "../../db/types.js";
import { runTransaction } from "../../db/tx.js";

describe("runTransaction", () => {
  it("serializes concurrent transactions on the same database connection", async () => {
    const db = { run: vi.fn() } as unknown as DrizzleDB;
    const entered: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });

    const first = runTransaction(db, async () => {
      entered.push("first");
      await firstGate;
      return 1;
    });
    await Promise.resolve();
    const second = runTransaction(db, async () => {
      entered.push("second");
      return 2;
    });
    await Promise.resolve();

    expect(entered).toEqual(["first"]);
    releaseFirst();
    await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);
    expect(entered).toEqual(["first", "second"]);
  });
});
