import { describe, expect, it } from "vitest";
import { protocolClientArgs, shouldReuseSyncToken } from "../cloudAuth";

describe("cloud authentication token reuse", () => {
  it("reuses a stored token during normal startup", () => {
    expect(shouldReuseSyncToken("stored-token", true, false)).toBe(true);
  });

  it("does not reuse a rejected token during explicit sign-in", () => {
    expect(shouldReuseSyncToken("expired-token", true, true)).toBe(false);
  });

  it("cannot reuse a token before the embedded server is ready", () => {
    expect(shouldReuseSyncToken("stored-token", false, false)).toBe(false);
  });
});

describe("desktop auth protocol registration", () => {
  it("registers packaged apps without development arguments", () => {
    expect(protocolClientArgs(false, "/Applications/Balance.app/Contents/MacOS/Balance", undefined))
      .toEqual({ executable: undefined, args: undefined });
  });

  it("routes callbacks back to the development app entry", () => {
    expect(protocolClientArgs(true, "/path/to/Electron", "/repo/desktop"))
      .toEqual({ executable: "/path/to/Electron", args: ["/repo/desktop"] });
  });
});
