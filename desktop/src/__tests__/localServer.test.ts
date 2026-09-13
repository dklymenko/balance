import { EventEmitter } from "node:events";
import { describe, it, expect, vi } from "vitest";
import { parseServerMessage, buildServerEnv, stopUtilityProcess } from "../localServer";

// The embedded server (packaged @balance/server, forked as a
// utilityProcess) talks to the shell over env vars in and messages out.
// These are the pure halves of that contract.

describe("parseServerMessage", () => {
  it("recognizes the listening report", () => {
    expect(parseServerMessage({ type: "listening", port: 43210 }))
      .toEqual({ type: "listening", port: 43210 });
  });

  it("recognizes backup completion and failure", () => {
    expect(parseServerMessage({ type: "backup-done", path: "/x/balance-2026-07-13.db" }))
      .toEqual({ type: "backup-done", path: "/x/balance-2026-07-13.db" });
    expect(parseServerMessage({ type: "backup-done", error: "disk full" }))
      .toEqual({ type: "backup-done", error: "disk full" });
  });

  it("rejects junk (wrong shape, bad port, unknown type)", () => {
    expect(parseServerMessage(null)).toBeNull();
    expect(parseServerMessage("listening")).toBeNull();
    expect(parseServerMessage({ type: "listening" })).toBeNull();
    expect(parseServerMessage({ type: "listening", port: "80" })).toBeNull();
    expect(parseServerMessage({ type: "listening", port: -1 })).toBeNull();
    expect(parseServerMessage({ type: "listening", port: 70000 })).toBeNull();
    expect(parseServerMessage({ type: "selfdestruct" })).toBeNull();
  });
});

describe("buildServerEnv", () => {
  it("sets the embedded-server contract env vars", () => {
    const env = buildServerEnv({
      dbPath: "/ud/balance.db",
      backupDir: "/ud/backups",
      localAuthToken: "synthetic-token",
    });
    expect(env.DATABASE_URL).toBe("/ud/balance.db");
    expect(env.BACKUP_DIR).toBe("/ud/backups");
    expect(env.PORT).toBe("0"); // kernel-assigned; never a fixed port
    expect(env.NODE_ENV).toBe("production"); // turns on static client serving
    expect(env.BALANCE_LOCAL_TOKEN).toBe("synthetic-token");
  });
});

describe("stopUtilityProcess", () => {
  it("does not resolve until the utility process has actually exited", async () => {
    const child = new EventEmitter() as EventEmitter & { kill(): boolean };
    child.kill = vi.fn(() => true);
    let stopped = false;
    const stopping = stopUtilityProcess(child).then(() => { stopped = true; });
    await Promise.resolve();
    expect(child.kill).toHaveBeenCalledOnce();
    expect(stopped).toBe(false);
    child.emit("exit", 0);
    await stopping;
    expect(stopped).toBe(true);
  });
});
