import { describe, it, expect, vi } from "vitest";
import { parseSampleDataFlag, requestSampleData } from "../sampleDataFlag";

describe("parseSampleDataFlag", () => {
  it("is absent unless the flag is passed", () => {
    expect(parseSampleDataFlag([])).toBeNull();
    expect(parseSampleDataFlag(["desktop", "--inspect"])).toBeNull();
    expect(parseSampleDataFlag(["--sample-database"])).toBeNull();
  });

  it("defaults the bare flag to the 3-year dataset", () => {
    expect(parseSampleDataFlag(["desktop", "--sample-data"])).toEqual({ dataset: "extended" });
  });

  it("accepts an explicit dataset", () => {
    expect(parseSampleDataFlag(["--sample-data=starter"])).toEqual({ dataset: "starter" });
    expect(parseSampleDataFlag(["--sample-data=extended"])).toEqual({ dataset: "extended" });
  });

  it("reports an unknown dataset instead of guessing", () => {
    const flag = parseSampleDataFlag(["--sample-data=huge"]);
    expect(flag).toHaveProperty("error");
    expect((flag as { error: string }).error).toContain("huge");
    expect(parseSampleDataFlag(["--sample-data="])).toHaveProperty("error");
  });
});

describe("requestSampleData", () => {
  const response = (status: number, body: unknown) => ({
    status, ok: status >= 200 && status < 300, json: async () => body,
  });

  it("posts the dataset to the local server with the bearer token", async () => {
    const fetchImpl = vi.fn(async () => response(201, { ok: true, accounts: 6, transactions: 3100 }));
    const outcome = await requestSampleData("http://127.0.0.1:4321", "tok", "extended", fetchImpl);
    expect(outcome).toEqual({ status: "seeded", dataset: "extended", accounts: 6, transactions: 3100 });
    expect(fetchImpl).toHaveBeenCalledWith("http://127.0.0.1:4321/api/data/sample", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer tok" },
      body: JSON.stringify({ dataset: "extended" }),
    });
  });

  it("skips a ledger that already has data", async () => {
    const fetchImpl = vi.fn(async () => response(400, { error: "Sample data can only be loaded into an empty household." }));
    expect(await requestSampleData("http://127.0.0.1:1", "t", "starter", fetchImpl))
      .toEqual({ status: "skipped", reason: "Sample data can only be loaded into an empty household." });
  });

  it("reports server and network failures", async () => {
    expect(await requestSampleData("http://127.0.0.1:1", "t", "starter", async () => response(500, {})))
      .toEqual({ status: "failed", reason: "HTTP 500" });
    expect(await requestSampleData("http://127.0.0.1:1", "t", "starter", async () => { throw new Error("ECONNREFUSED"); }))
      .toEqual({ status: "failed", reason: "ECONNREFUSED" });
  });
});
