import { describe, expect, it } from "vitest";
import { AMAZON_PARTITION, CLOUD_AUTH_PARTITION, LOCAL_PARTITION } from "../partitions";

describe("desktop session partitions", () => {
  it("persists only Balance UI preferences, never third-party auth sessions", () => {
    expect(LOCAL_PARTITION).toBe("persist:balance-local");
    expect(AMAZON_PARTITION.startsWith("persist:")).toBe(false);
    expect(CLOUD_AUTH_PARTITION.startsWith("persist:")).toBe(false);
  });
});
