import { Router } from "express";
import { eq } from "drizzle-orm";
import type { DrizzleDB } from "../db/types.js";
import { settings } from "../db/schema.js";

// Base currency is the local household-level setting. It supplies the default
// currency for new accounts and is surfaced through /api/me.

const CURRENCY_RE = /^[A-Z]{3}$/;

export async function getSetting(db: DrizzleDB, key: string): Promise<string | null> {
  const [row] = await db.select().from(settings).where(eq(settings.key, key));
  return row?.value ?? null;
}

export function createSettingsRouter(db: DrizzleDB) {
  const router = Router();

  router.patch("/", async (req, res) => {
    try {
      const { base_currency } = req.body as { base_currency?: unknown };
      if (base_currency !== undefined) {
        if (typeof base_currency !== "string" || !CURRENCY_RE.test(base_currency)) {
          return res.status(400).json({ error: "base_currency must be a 3-letter currency code" });
        }
        await db.insert(settings).values({ key: "base_currency", value: base_currency })
          .onConflictDoUpdate({ target: settings.key, set: { value: base_currency } });
      }
      res.json({ ok: true, base_currency: await getSetting(db, "base_currency") ?? "USD" });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to update settings" });
    }
  });

  return router;
}
