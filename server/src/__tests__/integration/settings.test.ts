import { describe, it, expect } from "vitest";
import request from "supertest";
import { createApp } from "../../app.js";
import { createTestDb } from "../../test/db.js";

// Base currency lives in the settings table and is surfaced through /api/me.

describe("settings", () => {
  it("defaults base_currency to USD in /api/me", async () => {
    const app = createApp(createTestDb());
    const res = await request(app).get("/api/me");
    expect(res.status).toBe(200);
    expect(res.body.household.base_currency).toBe("USD");
    expect(res.body.household.name).toBe("Balance");
    expect(res.body.user.role).toBe("admin");
  });

  it("PATCH /api/settings updates base_currency and /api/me reflects it", async () => {
    const app = createApp(createTestDb());
    const patch = await request(app).patch("/api/settings").send({ base_currency: "EUR" });
    expect(patch.status).toBe(200);
    expect(patch.body.base_currency).toBe("EUR");

    const me = await request(app).get("/api/me");
    expect(me.body.household.base_currency).toBe("EUR");

    // Upsert, not insert-only.
    await request(app).patch("/api/settings").send({ base_currency: "UAH" });
    expect((await request(app).get("/api/me")).body.household.base_currency).toBe("UAH");
  });

  it("rejects a malformed currency code", async () => {
    const app = createApp(createTestDb());
    expect((await request(app).patch("/api/settings").send({ base_currency: "eur" })).status).toBe(400);
    expect((await request(app).patch("/api/settings").send({ base_currency: "EURO" })).status).toBe(400);
    expect((await request(app).patch("/api/settings").send({ base_currency: 5 })).status).toBe(400);
  });
});
