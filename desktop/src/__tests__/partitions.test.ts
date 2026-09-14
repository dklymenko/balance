import { describe, expect, it } from "vitest";
import {
  AMAZON_PARTITION,
  CLOUD_AUTH_PARTITION,
  LOCAL_PARTITION,
  amazonPartitionFor,
} from "../partitions";

describe("desktop session partitions", () => {
  it("persists the isolated Amazon session but keeps Cloud auth memory-only", () => {
    expect(LOCAL_PARTITION).toBe("persist:balance-local");
    expect(AMAZON_PARTITION).toBe("persist:balance-amazon");
    expect(CLOUD_AUTH_PARTITION.startsWith("persist:")).toBe(false);
    expect(new Set([LOCAL_PARTITION, AMAZON_PARTITION, CLOUD_AUTH_PARTITION]).size).toBe(3);
  });

  it("never persists Amazon cookies under the unfused development Electron binary", () => {
    expect(amazonPartitionFor(true)).toBe(AMAZON_PARTITION);
    expect(amazonPartitionFor(false)).toBe("amazon");
  });
});
