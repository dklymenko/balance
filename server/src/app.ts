import express from "express";
import { timingSafeEqual } from "node:crypto";
import path from "node:path";
import type { NextFunction, Request, Response } from "express";
import type { DrizzleDB } from "./db/types.js";
import { createAccountsRouter } from "./routes/accounts.js";
import { createTransactionsRouter, type BudgetAppMapping } from "./routes/transactions.js";
import { createCategoriesRouter } from "./routes/categories.js";
import { createTagsRouter } from "./routes/tags.js";
import { createReportsRouter } from "./routes/reports.js";
import { createImportsRouter } from "./routes/imports.js";
import { createDataRouter } from "./routes/data.js";
import { createInsightsRouter } from "./routes/insights.js";
import { createSettingsRouter, getSetting } from "./routes/settings.js";
import type { ScrapeFn } from "./lib/amazonScraper.js";
import { readLocalSettings, type LocalSettings } from "./lib/localSettings.js";
import { LOCAL_HOUSEHOLD_NAME } from "./lib/identity.js";

export interface AppSecurityOptions {
  // Balance Desktop supplies one random token per launch. The shell injects
  // it as a bearer header only for the exact embedded-server origin, so a
  // website, DNS rebinding attempt, or unrelated local process cannot read or
  // mutate the ledger merely by discovering the loopback port.
  localAuthToken?: string;
}

function tokenMatches(expected: string, authorization: string | undefined): boolean {
  const prefix = "Bearer ";
  if (!authorization?.startsWith(prefix)) return false;
  const supplied = authorization.slice(prefix.length);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(supplied, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function isLoopbackUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    const hostname = url.hostname.toLowerCase();
    return (url.protocol === "http:" || url.protocol === "https:") &&
      !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash &&
      (hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]");
  } catch {
    return false;
  }
}

function isLoopbackHost(host: string | undefined): boolean {
  return typeof host === "string" && isLoopbackUrl(`http://${host}`);
}

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'none'",
  "connect-src 'self'",
  "font-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "img-src 'self' data:",
  "object-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
].join("; ");

export function createApp(
  db: DrizzleDB,
  budgetAppMapping?: BudgetAppMapping,
  amazonScrapeFn: ScrapeFn | null = null,
  readSettings: () => LocalSettings = readLocalSettings,
  security: AppSecurityOptions = {},
) {
  const app = express();

  app.disable("x-powered-by");
  app.use((req, res, next) => {
    res.setHeader("Content-Security-Policy", CONTENT_SECURITY_POLICY);
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    if (req.path.startsWith("/api")) res.setHeader("Cache-Control", "no-store");
    next();
  });

  // The development server intentionally has no bearer token, so also defend
  // it against DNS rebinding and cross-site form requests. The packaged app
  // passes these checks too: its API and renderer both use the exact loopback
  // origin. CLI clients without an Origin header remain supported.
  app.use((req, res, next) => {
    const origin = req.get("origin");
    if (!isLoopbackHost(req.get("host")) || (origin && !isLoopbackUrl(origin))) {
      return res.status(403).json({ error: "Forbidden" });
    }
    next();
  });

  const localAuthToken = security.localAuthToken ?? process.env.BALANCE_LOCAL_TOKEN;
  if (localAuthToken) {
    app.use((req, res, next) => {
      if (!tokenMatches(localAuthToken, req.get("authorization"))) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      next();
    });
  }

  app.use(express.json({ limit: "10mb" }));
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (err instanceof SyntaxError && "body" in err) {
      return res.status(400).json({ error: "Malformed JSON body" });
    }
    next(err);
  });
  app.use((req, res, next) => {
    if (req.method === "POST" || req.method === "PUT" || req.method === "PATCH") {
      // Express leaves body undefined when no payload was sent. Normalizing it
      // lets each route return its own useful required-field error; JSON arrays
      // are never valid request envelopes in this API and are rejected here.
      req.body ??= {};
      if (typeof req.body !== "object" || Array.isArray(req.body)) {
        return res.status(400).json({ error: "JSON body must be an object" });
      }
    }
    next();
  });

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", ts: new Date().toISOString() });
  });

  // Local identity response lets the client render without a network account.
  // Role "admin" unlocks all administrative UI.
  app.get("/api/me", async (_req, res) => {
    const baseCurrency = (await getSetting(db, "base_currency")) ?? "USD";
    res.json({
      user: { id: 1, email: null, name: null, role: "admin" },
      household: { id: "local", name: LOCAL_HOUSEHOLD_NAME, base_currency: baseCurrency },
    });
  });

  app.use("/api/accounts", createAccountsRouter(db));
  app.use("/api/transactions", createTransactionsRouter(db, budgetAppMapping));
  app.use("/api/categories", createCategoriesRouter(db));
  app.use("/api/tags", createTagsRouter(db));
  app.use("/api/reports", createReportsRouter(db));
  app.use("/api/imports", createImportsRouter(db, amazonScrapeFn, readSettings));
  app.use("/api/data", createDataRouter(db));
  app.use("/api/insights", createInsightsRouter(db));
  app.use("/api/settings", createSettingsRouter(db));

  // Unmatched API routes return a JSON 404. Registered after all routers and
  // before the SPA fallback so an unknown /api path never receives index.html.
  app.use("/api", (_req, res) => res.status(404).json({ error: "Not found" }));

  // Production single-process serving: serve
  // the built client and SPA-fallback client-side routes. In dev the client is
  // served by Vite, so this stays off. CLIENT_DIST_PATH lets an embedding host
  // (Balance Desktop) point at the packaged client build.
  if (process.env.NODE_ENV === "production") {
    const clientDist = process.env.CLIENT_DIST_PATH ?? path.resolve(process.cwd(), "../client/dist");
    app.use(express.static(clientDist));
    app.use((req, res, next) => {
      if (req.method !== "GET" || req.path.startsWith("/api")) return next();
      res.sendFile(path.join(clientDist, "index.html"));
    });
  }

  return app;
}
