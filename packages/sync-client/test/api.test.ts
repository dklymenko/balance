import { describe, expect, it, vi } from "vitest";
import { SyncApi, SyncApiError } from "../src/api";

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("SyncApi", () => {
  it("rejects an insecure remote endpoint before credentials can be sent", () => {
    expect(() => new SyncApi({ baseUrl: "http://cloud.example.test", getToken: async () => "token" }))
      .toThrow(/HTTPS/);
    expect(() => new SyncApi({ baseUrl: "http://127.0.0.1:3000", getToken: async () => "token" }))
      .not.toThrow();
    for (const baseUrl of [
      "https://sync.example.test/prefix",
      "https://sync.example.test?redirect=evil",
      "https://sync.example.test#fragment",
      "https://user:pass@sync.example.test",
    ]) {
      expect(() => new SyncApi({ baseUrl, getToken: async () => "token" }), baseUrl).toThrow(/endpoint/i);
    }
  });

  it("rejects invalid outbound cursors and limits before making a request", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    const api = new SyncApi({ baseUrl: "https://sync.example.test", getToken: async () => "token", fetchFn });
    await expect(api.pull(-1)).rejects.toThrow(/cursor/i);
    await expect(api.pull(0, 0)).rejects.toThrow(/limit/i);
    await expect(api.snapshot(1.5)).rejects.toThrow(/cursor/i);
    await expect(api.activity(-2)).rejects.toThrow(/cursor/i);
    expect(fetchFn).not.toHaveBeenCalled();
  });
  it("requires a token before making a network request", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    const api = new SyncApi({ baseUrl: "https://sync.example.test/", getToken: async () => null, fetchFn });
    await expect(api.pull(0)).rejects.toMatchObject({ status: 401, message: "not signed in" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("sends bearer auth and validates a pull response", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(json({ cursor: 9, has_more: false, changes: [] }));
    const api = new SyncApi({ baseUrl: "https://sync.example.test/", getToken: async () => "synthetic-token", fetchFn });
    await expect(api.pull(4, 25)).resolves.toEqual({ cursor: 9, has_more: false, changes: [] });
    expect(fetchFn).toHaveBeenCalledWith(
      "https://sync.example.test/api/sync/pull?cursor=4&limit=25",
      expect.objectContaining({ headers: { Authorization: "Bearer synthetic-token" }, method: "GET" }),
    );
  });

  it("surfaces server errors and rejects malformed success payloads", async () => {
    const denied = new SyncApi({
      baseUrl: "https://sync.example.test",
      getToken: async () => "synthetic-token",
      fetchFn: vi.fn<typeof fetch>().mockResolvedValue(json({ error: "expired" }, 401)),
    });
    await expect(denied.pull(0)).rejects.toEqual(new SyncApiError("expired", 401));

    const malformed = new SyncApi({
      baseUrl: "https://sync.example.test",
      getToken: async () => "synthetic-token",
      fetchFn: vi.fn<typeof fetch>().mockResolvedValue(json({ cursor: "nine", changes: [] })),
    });
    await expect(malformed.pull(0)).rejects.toThrow("pull response cursor must be a non-negative integer");
  });

  it("rejects a non-integer enrollment cursor", async () => {
    const api = new SyncApi({
      baseUrl: "https://sync.example.test",
      getToken: async () => "synthetic-token",
      fetchFn: vi.fn<typeof fetch>().mockResolvedValue(json({ cursor: 1.5 })),
    });
    await expect(api.importArchive({} as never)).rejects.toThrow(/cursor/i);
  });
});
