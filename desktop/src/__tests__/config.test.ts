import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  cloudAvailable, cloudEndpoint, parseConfig, readConfig, reconcileConfigWithSyncMode, writeConfig,
} from "../config";

// userData/config.json decides the app mode at boot:
// { "mode": "local" | "cloud", "saasUrl"?: string }. No file (or an
// unreadable one) means first run -> the chooser window.

describe("parseConfig", () => {
  it("accepts the two valid modes", () => {
    expect(parseConfig('{"mode":"local"}')).toEqual({ mode: "local" });
    expect(parseConfig('{"mode":"cloud"}')).toEqual({ mode: "cloud" });
  });

  it("keeps only recognized crash-recovery transition markers", () => {
    expect(parseConfig('{"mode":"local","cloudTransition":"connecting"}'))
      .toEqual({ mode: "local", cloudTransition: "connecting" });
    expect(parseConfig('{"mode":"cloud","cloudTransition":"disconnecting"}'))
      .toEqual({ mode: "cloud", cloudTransition: "disconnecting" });
    expect(parseConfig('{"mode":"local","cloudTransition":"unknown"}'))
      .toEqual({ mode: "local" });
  });

  it("keeps a valid saasUrl override and drops a bogus one", () => {
    expect(parseConfig('{"mode":"cloud","saasUrl":"https://example.com"}'))
      .toEqual({ mode: "cloud", saasUrl: "https://example.com" });
    expect(parseConfig('{"mode":"cloud","saasUrl":"not a url"}'))
      .toEqual({ mode: "cloud" });
    expect(parseConfig('{"mode":"cloud","saasUrl":"file:///etc/passwd"}'))
      .toEqual({ mode: "cloud" });
    expect(parseConfig('{"mode":"cloud","saasUrl":"http://example.com"}'))
      .toEqual({ mode: "cloud" });
    expect(parseConfig('{"mode":"cloud","saasUrl":"http://127.0.0.1:3000"}'))
      .toEqual({ mode: "cloud", saasUrl: "http://127.0.0.1:3000" });
    expect(parseConfig('{"mode":"cloud","saasUrl":"https://user:secret@example.com"}'))
      .toEqual({ mode: "cloud" });
    expect(parseConfig('{"mode":"cloud","saasUrl":"https://example.com/service"}'))
      .toEqual({ mode: "cloud" });
  });

  it("returns null for malformed JSON, unknown mode, or empty input", () => {
    expect(parseConfig(null)).toBeNull();
    expect(parseConfig("")).toBeNull();
    expect(parseConfig("{nope")).toBeNull();
    expect(parseConfig('{"mode":"hybrid"}')).toBeNull();
    expect(parseConfig('"local"')).toBeNull();
  });
});

describe("readConfig / writeConfig", () => {
  it("round-trips through a config file and creates parent dirs", () => {
    const dir = mkdtempSync(join(tmpdir(), "balance-desktop-config-"));
    try {
      const file = join(dir, "nested", "config.json");
      expect(readConfig(file)).toBeNull(); // missing file = first run
      writeConfig(file, { mode: "local" });
      expect(existsSync(file)).toBe(true);
      expect(readConfig(file)).toEqual({ mode: "local" });
      writeConfig(file, { mode: "cloud" });
      expect(readConfig(file)).toEqual({ mode: "cloud" });
      expect(JSON.parse(readFileSync(file, "utf8")).mode).toBe("cloud");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("treats a corrupt file as first run instead of crashing", () => {
    const dir = mkdtempSync(join(tmpdir(), "balance-desktop-config-"));
    try {
      const file = join(dir, "config.json");
      writeFileSync(file, "garbage{{{");
      expect(readConfig(file)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("cloudAvailable", () => {
  // A brand new profile (no config yet) is the case that matters: this is what
  // the first-run chooser asks about, and the public answer must be no.
  it("is off for a first run with no override", () => {
    expect(cloudAvailable({}, null)).toBe(false);
  });

  it("is on when BALANCE_CLOUD=1 is set", () => {
    expect(cloudAvailable({ BALANCE_CLOUD: "1", BALANCE_SAAS_URL: "https://cloud.example.test" }, null)).toBe(true);
  });

  it("requires an explicit Cloud endpoint", () => {
    expect(cloudAvailable({ BALANCE_CLOUD: "1" }, null)).toBe(false);
  });

  it("ignores any other value of BALANCE_CLOUD", () => {
    expect(cloudAvailable({ BALANCE_CLOUD: "0" }, null)).toBe(false);
    expect(cloudAvailable({ BALANCE_CLOUD: "true" }, null)).toBe(false);
    expect(cloudAvailable({ BALANCE_CLOUD: "" }, null)).toBe(false);
  });

  // Hiding the feature must never strand someone already using it.
  it("stays on for a profile already enrolled in cloud mode", () => {
    expect(cloudAvailable({}, { mode: "cloud", saasUrl: "https://cloud.example.test" })).toBe(true);
  });

  it("is off for a local profile without an override", () => {
    expect(cloudAvailable({}, { mode: "local" })).toBe(false);
  });

  it("keeps a private endpoint available while an interrupted connection is recoverable", () => {
    expect(cloudAvailable({}, {
      mode: "local",
      saasUrl: "https://cloud.example.test",
      cloudTransition: "connecting",
    })).toBe(true);
  });
});

describe("reconcileConfigWithSyncMode", () => {
  const CLOUD = {
    mode: "cloud" as const,
    saasUrl: "https://cloud.example.test",
    syncToken: "wrapped-token",
    encryptionDeclined: true,
  };

  it("finishes a connecting transition when the database committed cloud mode", () => {
    expect(reconcileConfigWithSyncMode({ ...CLOUD, mode: "local", cloudTransition: "connecting" }, "cloud"))
      .toEqual(CLOUD);
  });

  it("keeps a connecting transition retryable when the database is still local", () => {
    const config = { ...CLOUD, mode: "local" as const, cloudTransition: "connecting" as const };
    expect(reconcileConfigWithSyncMode(config, "local")).toEqual(config);
  });

  it("finishes a disconnect and removes the obsolete token when the database is local", () => {
    expect(reconcileConfigWithSyncMode({ ...CLOUD, cloudTransition: "disconnecting" }, "local"))
      .toEqual({ mode: "local", saasUrl: CLOUD.saasUrl, encryptionDeclined: true });
  });

  it("returns to cloud mode if a disconnect did not commit", () => {
    expect(reconcileConfigWithSyncMode({ ...CLOUD, cloudTransition: "disconnecting" }, "cloud"))
      .toEqual(CLOUD);
  });

  it("treats the database as authoritative and never retains a token in local mode", () => {
    expect(reconcileConfigWithSyncMode(CLOUD, "local"))
      .toEqual({ mode: "local", saasUrl: CLOUD.saasUrl, encryptionDeclined: true });
  });
});

describe("cloudEndpoint", () => {
  it("normalizes an explicit origin and lets the environment override stored configuration", () => {
    expect(cloudEndpoint(
      { BALANCE_SAAS_URL: "https://new.example.test/" },
      { mode: "cloud", saasUrl: "https://old.example.test" },
    )).toBe("https://new.example.test");
  });

  it("accepts loopback HTTP only for local development", () => {
    expect(cloudEndpoint({ BALANCE_SAAS_URL: "http://localhost:4000" }, null)).toBe("http://localhost:4000");
    expect(cloudEndpoint({ BALANCE_SAAS_URL: "http://cloud.example.test" }, null)).toBeNull();
  });
});
