import { describe, expect, it } from "vitest";
import { secureStorageCodec, unwrapSecret, wrapSecret } from "../secureStorage";

describe("secureStorage adapter", () => {
  it("does not probe Keychain before the requested operation", () => {
    let probes = 0;
    let encryptions = 0;
    let decryptions = 0;
    const storage = {
      isEncryptionAvailable: () => { probes += 1; return true; },
      encryptString: (value: string) => {
        encryptions += 1;
        return Buffer.from(value, "utf8");
      },
      decryptString: (value: Buffer) => {
        decryptions += 1;
        return value.toString("utf8");
      },
    };

    const codec = secureStorageCodec(storage);
    expect(probes).toBe(0);
    expect(codec.encrypt("ledger key").toString("utf8")).toBe("ledger key");
    expect(probes).toBe(0);
    expect(encryptions).toBe(1);
    expect(codec.decrypt(Buffer.from("ledger key"))).toBe("ledger key");
    expect(probes).toBe(0);
    expect(decryptions).toBe(1);
  });

  it("wraps and unwraps a secret with one Keychain operation each", () => {
    let encryptions = 0;
    let decryptions = 0;
    const storage = {
      encryptString: (value: string) => {
        encryptions += 1;
        return Buffer.from(`sealed:${value}`, "utf8");
      },
      decryptString: (value: Buffer) => {
        decryptions += 1;
        return value.toString("utf8").replace(/^sealed:/, "");
      },
    };

    const wrapped = wrapSecret(storage, "cloud token");
    expect(wrapped).not.toBeNull();
    expect(encryptions).toBe(1);
    expect(unwrapSecret(storage, wrapped!)).toBe("cloud token");
    expect(decryptions).toBe(1);
  });

  it("reports unavailable secure storage without a separate probe", () => {
    const unavailable = {
      encryptString: (_value: string): Buffer => { throw new Error("unavailable"); },
      decryptString: (_value: Buffer): string => { throw new Error("unavailable"); },
    };

    expect(wrapSecret(unavailable, "secret")).toBeNull();
    expect(unwrapSecret(unavailable, Buffer.from("sealed").toString("base64"))).toBeNull();
    expect(unwrapSecret(unavailable, "not valid base64!")).toBeNull();
  });
});
