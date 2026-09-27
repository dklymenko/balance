import { useEffect, useState } from "react";
import {
  getDesktopCloud,
  type DesktopCloud,
  type DesktopCloudStatus,
} from "@/lib/desktopBridge";

function statusLabel(status: DesktopCloudStatus): string {
  if (status.connecting) return "Connecting…";
  if (status.state === "auth_required") return "Signed out";
  if (status.state === "syncing") return "Syncing…";
  if (status.state === "offline") return "Offline";
  if (status.state === "error") return "Sync error";
  return "Synced";
}

function pendingLabel(pending: number): string {
  if (pending === 0) return "All changes synced";
  return `${pending} ${pending === 1 ? "change" : "changes"} waiting to sync`;
}

export default function CloudSyncSection() {
  const cloud = getDesktopCloud();
  const [status, setStatus] = useState<DesktopCloudStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getDesktopCloud()?.status().then(setStatus).catch(() => {
      setError("Could not read Balance Cloud status.");
    });
  }, []);

  if (!cloud || !status || status.mode !== "cloud") return null;

  async function run(action: (bridge: DesktopCloud) => Promise<DesktopCloudStatus>) {
    setBusy(true);
    setError(null);
    try {
      setStatus(await action(cloud!));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Balance Cloud could not complete the request.");
      try { setStatus(await cloud!.status()); } catch { /* keep the last useful status */ }
    } finally {
      setBusy(false);
    }
  }

  const label = statusLabel(status);
  const unhealthy = status.state === "auth_required" || status.state === "offline" || status.state === "error";

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-medium">Balance Cloud</h2>
        <span className={`text-xs font-medium ${unhealthy ? "text-amber-600 dark:text-amber-300" : "text-muted-foreground"}`}>
          {label}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">
        {pendingLabel(status.pending)}
        {status.lastSyncAt ? ` · Last synced ${new Date(status.lastSyncAt).toLocaleString()}` : " · Never synced on this launch"}
      </p>
      {status.conflicts > 0 && (
        <p className="text-xs text-amber-600 dark:text-amber-300">
          {status.conflicts} recorded {status.conflicts === 1 ? "conflict" : "conflicts"}
        </p>
      )}
      {(error || status.message) && (
        <p role="alert" className="text-xs text-red-600 dark:text-red-300">
          {error ?? status.message}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {status.state === "auth_required" ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => void run((bridge) => bridge.signIn())}
            className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
          >
            {busy ? "Signing in…" : "Sign in"}
          </button>
        ) : (
          <button
            type="button"
            disabled={busy || status.connecting || status.state === "syncing"}
            onClick={() => void run((bridge) => bridge.syncNow())}
            className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
          >
            {busy || status.state === "syncing" ? "Syncing…" : "Sync now"}
          </button>
        )}
      </div>
    </section>
  );
}
