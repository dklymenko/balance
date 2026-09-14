import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readPngAlphaBounds } from "./pngAlphaBounds";

const builderConfig = readFileSync(
  resolve(process.cwd(), "electron-builder.yml"),
  "utf8",
);

describe("packaged application identity", () => {
  it("uses Balance as the macOS application and artifact name", () => {
    expect(builderConfig).toMatch(/^productName: Balance$/m);
    expect(builderConfig).toMatch(/^artifactName: Balance-\$\{version\}-\$\{arch\}\.\$\{ext\}$/m);
  });

  it("packages the polished Balance icon", () => {
    expect(builderConfig).toMatch(/^\s+icon: build\/icon-v2\.png$/m);
    const iconPath = resolve(process.cwd(), "build", "icon-v2.png");
    expect(existsSync(iconPath)).toBe(true);

    const bounds = readPngAlphaBounds(readFileSync(iconPath));
    const visibleWidth = bounds.right - bounds.left + 1;
    const visibleHeight = bounds.bottom - bounds.top + 1;
    expect([bounds.width, bounds.height]).toEqual([1024, 1024]);
    expect(visibleWidth).toBeGreaterThanOrEqual(800);
    expect(visibleWidth).toBeLessThanOrEqual(850);
    expect(visibleHeight).toBeGreaterThanOrEqual(800);
    expect(visibleHeight).toBeLessThanOrEqual(850);
    expect(Math.abs(bounds.left - (bounds.width - 1 - bounds.right))).toBeLessThanOrEqual(4);
    expect(Math.abs(bounds.top - (bounds.height - 1 - bounds.bottom))).toBeLessThanOrEqual(4);
  });

  it("encrypts cookies written by persistent browser sessions", () => {
    expect(builderConfig).toMatch(/^\s+enableCookieEncryption: true$/m);
  });
});
