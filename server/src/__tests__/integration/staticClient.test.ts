import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp } from "../../app.js";
import { createTestDb } from "../../test/db.js";

// Production single-binary serving: the server serves the built client and
// SPA-fallbacks client-side routes. Off
// outside NODE_ENV=production so dev keeps using Vite.

describe("static client serving", () => {
  let clientDist: string;
  const savedNodeEnv = process.env.NODE_ENV;
  const savedDistPath = process.env.CLIENT_DIST_PATH;

  beforeEach(() => {
    clientDist = mkdtempSync(join(tmpdir(), "balance-client-dist-"));
    writeFileSync(join(clientDist, "index.html"), "<html><body>balance-spa</body></html>");
    mkdirSync(join(clientDist, "assets"));
    writeFileSync(join(clientDist, "assets", "app.js"), "console.log('bundle');");
    process.env.CLIENT_DIST_PATH = clientDist;
  });

  afterEach(() => {
    rmSync(clientDist, { recursive: true, force: true });
    process.env.NODE_ENV = savedNodeEnv;
    if (savedDistPath === undefined) delete process.env.CLIENT_DIST_PATH;
    else process.env.CLIENT_DIST_PATH = savedDistPath;
  });

  function makeApp() {
    return createApp(createTestDb(), undefined, async () => []);
  }

  it("serves index.html at / in production", async () => {
    process.env.NODE_ENV = "production";
    const res = await request(makeApp()).get("/");
    expect(res.status).toBe(200);
    expect(res.text).toContain("balance-spa");
  });

  it("serves static assets in production", async () => {
    process.env.NODE_ENV = "production";
    const res = await request(makeApp()).get("/assets/app.js");
    expect(res.status).toBe(200);
    expect(res.text).toContain("bundle");
  });

  it("SPA-fallbacks unknown GET routes to index.html in production", async () => {
    process.env.NODE_ENV = "production";
    const res = await request(makeApp()).get("/transactions");
    expect(res.status).toBe(200);
    expect(res.text).toContain("balance-spa");
  });

  it("unmatched /api routes return JSON 404, never index.html", async () => {
    process.env.NODE_ENV = "production";
    const res = await request(makeApp()).get("/api/nope");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Not found" });
  });

  it("does not serve the client outside production", async () => {
    process.env.NODE_ENV = "test";
    const res = await request(makeApp()).get("/");
    expect(res.status).toBe(404);
  });
});
