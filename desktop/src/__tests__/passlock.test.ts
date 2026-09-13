import { describe, it, expect } from "vitest";
import { createVerifier, verifyPassword, parseVerifier, serializeVerifier } from "../passlock";

// App-lock password handling: only an scrypt verifier (salt + derived key)
// is ever stored -- never the password. Verification must be constant-time
// and the serialized form must round-trip (it gets wrapped by safeStorage
// on the way to disk).

describe("passlock", () => {
  it("accepts the right password and rejects wrong ones", () => {
    const v = createVerifier("correct horse battery staple");
    expect(verifyPassword("correct horse battery staple", v)).toBe(true);
    expect(verifyPassword("correct horse battery stapl", v)).toBe(false);
    expect(verifyPassword("", v)).toBe(false);
  });

  it("uses a fresh salt per verifier (same password, different hashes)", () => {
    const a = createVerifier("hunter2!!");
    const b = createVerifier("hunter2!!");
    expect(a.salt).not.toBe(b.salt);
    expect(a.hash).not.toBe(b.hash);
    expect(verifyPassword("hunter2!!", a)).toBe(true);
    expect(verifyPassword("hunter2!!", b)).toBe(true);
    expect(a.N).toBe(65536);
  });

  it("round-trips through serialization", () => {
    const v = createVerifier("s3cret-пароль");
    const restored = parseVerifier(serializeVerifier(v));
    expect(restored).not.toBeNull();
    expect(verifyPassword("s3cret-пароль", restored!)).toBe(true);
    expect(verifyPassword("nope", restored!)).toBe(false);
  });

  it("rejects malformed serialized data instead of throwing", () => {
    expect(parseVerifier("")).toBeNull();
    expect(parseVerifier("junk{{{")).toBeNull();
    expect(parseVerifier(JSON.stringify({ v: 99, salt: "x", hash: "y" }))).toBeNull();
    expect(parseVerifier(JSON.stringify({ v: 1, salt: "AAAA" }))).toBeNull();
    const v = createVerifier("long enough synthetic password");
    expect(parseVerifier(JSON.stringify({ ...v, N: 2 ** 30 }))).toBeNull();
    expect(parseVerifier(JSON.stringify({ ...v, r: 1024 }))).toBeNull();
    expect(parseVerifier(JSON.stringify({ ...v, hash: Buffer.alloc(2).toString("base64") }))).toBeNull();
  });

  it("verifies against tampered params safely", () => {
    const v = createVerifier("pw");
    const tampered = { ...v, hash: v.hash.slice(0, -4) + "AAAA" };
    expect(verifyPassword("pw", tampered)).toBe(false);
    expect(verifyPassword("pw", { ...v, N: 2 ** 30 })).toBe(false);
  });
});
