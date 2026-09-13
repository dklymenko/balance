import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../app.js";
import { createTestDb } from "../../test/db.js";

const TOKEN = "synthetic-launch-token";

afterEach(() => {
  delete process.env.BALANCE_LOCAL_TOKEN;
});

describe("embedded-server security boundary", () => {
  it("requires the per-launch bearer token when embedded auth is enabled", async () => {
    const app = createApp(createTestDb(), undefined, undefined, undefined, {
      localAuthToken: TOKEN,
    });

    expect((await request(app).get("/api/me")).status).toBe(401);
    expect((await request(app).get("/api/me").set("Authorization", "Bearer wrong")).status).toBe(401);

    const allowed = await request(app)
      .get("/api/me")
      .set("Authorization", `Bearer ${TOKEN}`);
    expect(allowed.status).toBe(200);
    expect(allowed.body.household.id).toBe("local");
  });

  it("keeps standalone development mode available when embedded auth is disabled", async () => {
    const res = await request(createApp(createTestDb())).get("/api/me");
    expect(res.status).toBe(200);
  });

  it("rejects DNS rebinding and cross-site requests in standalone development mode", async () => {
    const app = createApp(createTestDb());
    expect((await request(app).get("/api/me").set("Host", "attacker.example")).status).toBe(403);
    expect((await request(app).get("/api/me").set("Host", "attacker.example@127.0.0.1")).status).toBe(403);
    expect((await request(app).get("/api/me").set("Host", "127.0.0.1/not-a-host")).status).toBe(403);
    expect((await request(app).post("/api/data/sample").set("Origin", "https://attacker.example")).status).toBe(403);
    expect((await request(app).get("/api/me").set("Origin", "http://attacker.example@127.0.0.1")).status).toBe(403);
    expect((await request(app).get("/api/me").set("Origin", "ftp://localhost")).status).toBe(403);
    expect((await request(app).get("/api/me").set("Origin", "http://127.0.0.1:5273")).status).toBe(200);
  });

  it("sets a restrictive browser policy on every response", async () => {
    const res = await request(createApp(createTestDb())).get("/api/health");
    expect(res.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(res.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(res.headers["permissions-policy"]).toContain("camera=()");
  });

  it("returns JSON 400 for malformed JSON instead of an HTML error page", async () => {
    const res = await request(createApp(createTestDb()))
      .post("/api/accounts")
      .set("Content-Type", "application/json")
      .send('{"name":');
    expect(res.status).toBe(400);
    expect(res.type).toContain("json");
    expect(res.body).toEqual({ error: "Malformed JSON body" });
  });

  it("rejects non-object JSON bodies and lets object-validation handle an empty body", async () => {
    const app = createApp(createTestDb());
    for (const body of [null, "not an object", 7]) {
      const res = await request(app)
        .post("/api/transactions")
        .set("Content-Type", "application/json")
        .send(JSON.stringify(body));
      expect(res.status).toBe(400);
      expect(res.type).toContain("json");
    }

    const array = await request(app).post("/api/transactions").send([]);
    expect(array.status).toBe(400);
    expect(array.body).toEqual({ error: "JSON body must be an object" });

    const missing = await request(app).post("/api/transactions");
    expect(missing.status).toBe(400);
    expect(missing.type).toContain("json");
  });
});
