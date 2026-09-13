import { describe, expect, it } from "vitest";
import { SyncApi } from "@balance/sync-client";
import { LOCAL_ONLY_SYNC_ENDPOINT, cloudAvailable, cloudEndpoint } from "../config";

// Regression: the embedded server always constructs a SyncApi, even with no
// Cloud configured, because the shell queries sync status on every boot. The
// placeholder endpoint it used ("http://invalid.localhost") did not satisfy
// SyncApi's own endpoint validation, so the constructor threw, the
// utilityProcess exited 1, and the app died on launch with "Embedded server
// exited with code 1 before listening" -- in local-only mode, the default and
// only path available to a source user. Nothing covered this because no test
// exercised serverEntry's boot sequence.

const api = (baseUrl: string) =>
  new SyncApi({ baseUrl, getToken: async () => null, fetchFn: fetch });

describe("local-only boot", () => {
  it("accepts the placeholder endpoint the embedded server falls back to", () => {
    expect(() => api(LOCAL_ONLY_SYNC_ENDPOINT)).not.toThrow();
  });

  it("keeps the placeholder on loopback so it can never leave the machine", () => {
    const url = new URL(LOCAL_ONLY_SYNC_ENDPOINT);
    expect(url.protocol).toBe("http:");
    expect(url.hostname).toBe("127.0.0.1");
    expect(url.pathname).toBe("/");
    expect(url.search).toBe("");
    expect(url.hash).toBe("");
    expect(url.username).toBe("");
  });

  it("is not a configured endpoint, so local mode stays local", () => {
    // The placeholder must never make the app believe Cloud is set up.
    expect(cloudEndpoint({}, null)).toBeNull();
    expect(cloudAvailable({}, null)).toBe(false);
    expect(cloudAvailable({ BALANCE_CLOUD: "1" }, null)).toBe(false);
  });

  it("still rejects endpoints that are genuinely unusable", () => {
    // Guards the assertion above: SyncApi validation is real, and the previous
    // placeholder is exactly the shape it refuses.
    expect(() => api("http://invalid.localhost")).toThrow(/Cloud endpoint/);
    expect(() => api("http://evil.example.com")).toThrow(/Cloud endpoint/);
    expect(() => api("https://u:p@example.invalid")).toThrow(/Cloud endpoint/);
    expect(() => api("https://example.invalid/path")).toThrow(/Cloud endpoint/);
  });
});
