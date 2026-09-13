import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { runBackup } from "../../lib/backup.js";

describe("runBackup", () => {
  it("writes a readable snapshot with owner-only permissions", async () => {
    const root = mkdtempSync(join(tmpdir(), "balance-backup-test-"));
    const source = new Database(join(root, "source.db"));
    try {
      source.exec("CREATE TABLE sample (value TEXT); INSERT INTO sample VALUES ('synthetic');");
      const destination = await runBackup(source, join(root, "backups"));

      expect(statSync(destination).mode & 0o777).toBe(0o600);
      expect(statSync(join(root, "backups")).mode & 0o777).toBe(0o700);
      expect(readdirSync(join(root, "backups")).some((file) => file.endsWith(".partial"))).toBe(false);

      const snapshot = new Database(destination, { readonly: true });
      try {
        expect(snapshot.prepare("SELECT value FROM sample").pluck().get()).toBe("synthetic");
      } finally {
        snapshot.close();
      }
    } finally {
      source.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("writes a fresh snapshot when two backups happen in the same second", async () => {
    const root = mkdtempSync(join(tmpdir(), "balance-backup-test-"));
    const source = new Database(join(root, "source.db"));
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-23T12:34:56.000Z"));
    try {
      source.exec("CREATE TABLE sample (value TEXT); INSERT INTO sample VALUES ('first');");
      const first = await runBackup(source, join(root, "backups"));
      source.exec("UPDATE sample SET value = 'second';");
      const second = await runBackup(source, join(root, "backups"));

      expect(second).not.toBe(first);
      const snapshot = new Database(second, { readonly: true });
      try {
        expect(snapshot.prepare("SELECT value FROM sample").pluck().get()).toBe("second");
      } finally {
        snapshot.close();
      }
    } finally {
      vi.useRealTimers();
      source.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
