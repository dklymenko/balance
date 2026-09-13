import { readFileSync } from "node:fs";
import { writeAtomicFile } from "./atomicFile";

// userData/config.json -- the mode switch. Both modes run the embedded server
// against the SQLite file in userData; "cloud" additionally enables the sync
// engine. saasUrl is the explicitly configured service origin.
// syncToken is a short-lived session token wrapped by safeStorage (base64),
// never stored in the clear. A missing or unreadable file means first run and
// brings up the chooser window.

export type AppMode = "local" | "cloud";
export type CloudTransition = "connecting" | "disconnecting";

// A local-only profile still constructs the sync engine, because the shell
// queries sync status on every boot, but it has no endpoint to point it at.
// This placeholder stands in for one. It is never contacted: every send path
// is gated on cloud mode and a session token, neither of which exists locally.
// It must still satisfy SyncApi's endpoint validation (loopback HTTP, bare
// origin), so it cannot be an unresolvable name -- an invalid value here stops
// the embedded server from booting at all, which is a total local-mode outage.
// Port 1 is privileged and never bound by application software.
export const LOCAL_ONLY_SYNC_ENDPOINT = "http://127.0.0.1:1";

export interface AppConfig {
  mode: AppMode;
  saasUrl?: string;
  syncToken?: string;
  // Crash-recovery journal for the only cross-process state change in the
  // shell. The embedded database commits its sync mode independently from
  // this file; this marker makes every possible restart state unambiguous.
  cloudTransition?: CloudTransition;
  // At-rest encryption is opt-in. Set once the user has declined the offer so
  // the app stops asking; Settings can still turn it on later. The authority
  // on whether the ledger IS encrypted is the database file itself, never this
  // flag, so the two can never disagree.
  encryptionDeclined?: boolean;
}

function normalizeCloudUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    const secure = u.protocol === "https:";
    const loopback = u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "localhost");
    if ((!secure && !loopback) || u.username || u.password || u.pathname !== "/" || u.search || u.hash) return null;
    return u.origin;
  } catch {
    return null;
  }
}

export function cloudEndpoint(
  env: { BALANCE_SAAS_URL?: string },
  config: AppConfig | null,
): string | null {
  const raw = env.BALANCE_SAAS_URL ?? config?.saasUrl;
  return typeof raw === "string" ? normalizeCloudUrl(raw) : null;
}

export function parseConfig(raw: string | null | undefined): AppConfig | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { mode?: unknown; saasUrl?: unknown };
    if (typeof parsed !== "object" || parsed === null) return null;
    if (parsed.mode !== "local" && parsed.mode !== "cloud") return null;
    const config: AppConfig = { mode: parsed.mode };
    if (typeof parsed.saasUrl === "string") {
      const endpoint = normalizeCloudUrl(parsed.saasUrl);
      if (endpoint) config.saasUrl = endpoint;
    }
    const token = (parsed as { syncToken?: unknown }).syncToken;
    if (typeof token === "string" && token.length > 0 && token.length <= 65_536) {
      config.syncToken = token;
    }
    if ((parsed as { encryptionDeclined?: unknown }).encryptionDeclined === true) {
      config.encryptionDeclined = true;
    }
    const transition = (parsed as { cloudTransition?: unknown }).cloudTransition;
    if (transition === "connecting" || transition === "disconnecting") {
      config.cloudTransition = transition;
    }
    return config;
  } catch {
    return null;
  }
}

// Balance Cloud is not open to the public yet, so the first-run chooser greys
// it out and the menu hides the connect item. Two things turn it back on
// without a code change: BALANCE_CLOUD=1 for this launch, and a profile that is
// already enrolled, so hiding the option never strands an existing install.
export function cloudAvailable(
  env: { BALANCE_CLOUD?: string; BALANCE_SAAS_URL?: string },
  config: AppConfig | null,
): boolean {
  return cloudEndpoint(env, config) !== null &&
    (env.BALANCE_CLOUD === "1" || config?.mode === "cloud" || config?.cloudTransition === "connecting");
}

// The embedded database is authoritative about whether replication is
// active. This reconciles it with the shell file after a crash while retaining
// enough state to resume a connection that had not committed yet. Returning
// to local mode always drops the obsolete wrapped session token.
export function reconcileConfigWithSyncMode(config: AppConfig, dbMode: AppMode): AppConfig {
  if (config.cloudTransition === "connecting" && dbMode === "local") {
    return { ...config, mode: "local" };
  }

  const { cloudTransition: _transition, ...withoutTransition } = config;
  void _transition;
  if (dbMode === "cloud") return { ...withoutTransition, mode: "cloud" };

  const { syncToken: _token, ...local } = withoutTransition;
  void _token;
  return { ...local, mode: "local" };
}

export function readConfig(configPath: string): AppConfig | null {
  try {
    return parseConfig(readFileSync(configPath, "utf8"));
  } catch {
    return null;
  }
}

// Write-then-rename so a crash mid-write can never leave a truncated config
// (which would silently reset the user to the first-run chooser).
export function writeConfig(configPath: string, config: AppConfig): void {
  writeAtomicFile(configPath, JSON.stringify(config, null, 2) + "\n");
}
