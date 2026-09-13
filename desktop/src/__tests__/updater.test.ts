import { describe, expect, it } from "vitest";
import { isNewer, parseLatestRelease, parseVersion } from "../updater";

describe("parseVersion", () => {
  it("accepts tags with and without the v prefix", () => {
    expect(parseVersion("v1.2.3")).toEqual([1, 2, 3]);
    expect(parseVersion("1.2.3")).toEqual([1, 2, 3]);
    expect(parseVersion("  v0.2.0 ")).toEqual([0, 2, 0]);
  });

  it("rejects anything that is not three numeric parts", () => {
    for (const bad of ["v1.2", "1.2.3.4", "v1.2.3-beta", "latest", ""]) {
      expect(parseVersion(bad)).toBeNull();
    }
  });
});

describe("isNewer", () => {
  it("compares each part in order", () => {
    expect(isNewer("v0.3.0", "v0.2.9")).toBe(true);
    expect(isNewer("v1.0.0", "v0.99.99")).toBe(true);
    expect(isNewer("v0.2.1", "v0.2.0")).toBe(true);
  });

  it("is false for the same, an older, or an invalid version", () => {
    expect(isNewer("v0.2.0", "v0.2.0")).toBe(false);
    expect(isNewer("v0.1.9", "v0.2.0")).toBe(false);
    expect(isNewer("nightly", "v0.2.0")).toBe(false);
    expect(isNewer("v0.3.0", "unknown")).toBe(false);
  });
});

describe("parseLatestRelease", () => {
  it("accepts a stable semantic version and constructs a trusted URL", () => {
    expect(parseLatestRelease({
      tag_name: "v0.3.0",
      body: "Fixes a thing",
      html_url: "https://attacker.example/download",
    })).toEqual({
      tag: "v0.3.0",
      notes: "Fixes a thing",
      url: "https://github.com/dklymenko/balance/releases/tag/v0.3.0",
    });
  });

  it("ignores drafts, prereleases, invalid tags, and junk", () => {
    expect(parseLatestRelease({ tag_name: "v0.3.0", draft: true })).toBeNull();
    expect(parseLatestRelease({ tag_name: "v0.3.0", prerelease: true })).toBeNull();
    expect(parseLatestRelease({ tag_name: "nightly" })).toBeNull();
    expect(parseLatestRelease(null)).toBeNull();
    expect(parseLatestRelease({})).toBeNull();
  });
});
