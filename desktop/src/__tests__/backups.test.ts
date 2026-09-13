import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, utimesSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { lastBackup, formatLastBackup } from "../backups";

// The daily schedule and pruning live in the embedded server (its
// lib/backup.ts); the shell only *reads* the backup dir to surface
// "Last backup: ..." in the app menu.

describe("lastBackup", () => {
  it("returns the newest balance-*.db snapshot", () => {
    const dir = mkdtempSync(join(tmpdir(), "balance-desktop-backups-"));
    try {
      const old = join(dir, "balance-2026-07-01T03-00-00.db");
      const fresh = join(dir, "balance-2026-07-12T03-00-00.db");
      writeFileSync(old, "x");
      writeFileSync(fresh, "x");
      const lookalike = join(dir, "balance-personal-copy.db");
      writeFileSync(lookalike, "x");
      utimesSync(old, new Date("2026-07-01T03:00:00Z"), new Date("2026-07-01T03:00:00Z"));
      utimesSync(fresh, new Date("2026-07-12T03:00:00Z"), new Date("2026-07-12T03:00:00Z"));
      utimesSync(lookalike, new Date("2026-07-13T03:00:00Z"), new Date("2026-07-13T03:00:00Z"));
      writeFileSync(join(dir, "unrelated.txt"), "x");

      const info = lastBackup(dir);
      expect(info?.file).toBe("balance-2026-07-12T03-00-00.db");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null for a missing or empty dir", () => {
    const dir = mkdtempSync(join(tmpdir(), "balance-desktop-backups-"));
    try {
      expect(lastBackup(join(dir, "nope"))).toBeNull();
      mkdirSync(join(dir, "empty"));
      expect(lastBackup(join(dir, "empty"))).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("formatLastBackup", () => {
  const now = new Date("2026-07-13T12:00:00Z").getTime();

  it("renders never / minutes / hours / days", () => {
    expect(formatLastBackup(null, now)).toBe("Last backup: never");
    expect(formatLastBackup({ file: "b", mtimeMs: now - 30_000 }, now)).toBe("Last backup: just now");
    expect(formatLastBackup({ file: "b", mtimeMs: now - 5 * 60_000 }, now)).toBe("Last backup: 5 min ago");
    expect(formatLastBackup({ file: "b", mtimeMs: now - 3 * 3_600_000 }, now)).toBe("Last backup: 3 h ago");
    expect(formatLastBackup({ file: "b", mtimeMs: now - 2 * 86_400_000 }, now)).toBe("Last backup: 2 days ago");
  });
});
