import { describe, expect, it, vi } from "vitest";
import { flushAmazonSignIn, forgetAmazonSignIn } from "../amazonSession";

describe("Amazon sign-in storage", () => {
  it("flushes encrypted cookies before the Amazon window closes", async () => {
    const flushStore = vi.fn().mockResolvedValue(undefined);

    await flushAmazonSignIn({ cookies: { flushStore } });

    expect(flushStore).toHaveBeenCalledOnce();
  });

  it("removes the complete isolated Amazon session on request", async () => {
    const calls: string[] = [];
    const target = {
      closeAllConnections: vi.fn(async () => { calls.push("connections"); }),
      clearAuthCache: vi.fn(async () => { calls.push("auth"); }),
      clearStorageData: vi.fn(async () => { calls.push("storage"); }),
      clearCache: vi.fn(async () => { calls.push("cache"); }),
    };

    await forgetAmazonSignIn(target);

    expect(calls).toEqual(["connections", "auth", "storage", "cache"]);
    expect(target.clearStorageData).toHaveBeenCalledWith();
  });
});
