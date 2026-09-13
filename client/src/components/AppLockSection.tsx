import { useEffect, useState } from "react";
import { getDesktopAppLock, type AppLockStatus } from "@/lib/desktopBridge";

// Security section of Settings -- only rendered inside the Balance Desktop
// shell (the app lock is a shell feature). Password entry happens in a
// native window owned by the shell; this page never sees a password.
export default function AppLockSection() {
  const lock = getDesktopAppLock();
  const [status, setStatus] = useState<AppLockStatus | null>(null);

  useEffect(() => {
    getDesktopAppLock()?.status().then(setStatus).catch(() => {});
  }, []);

  if (!lock || !status) return null;

  const refresh = (p: Promise<AppLockStatus>) => { p.then(setStatus).catch(() => {}); };
  const btn = "rounded-md border px-3 py-1.5 text-sm hover:bg-muted";

  return (
    <section className="space-y-2">
      <h2 className="text-sm font-medium">Security</h2>
      <p className="text-xs text-muted-foreground">
        {status.enabled
          ? `Balance asks for a password${status.touchId ? " or Touch ID" : ""} when it opens and after your Mac sleeps. Cmd+L locks it any time.`
          : "Require a password to open Balance on this Mac. The password is stored only as a secure verifier, sealed with your macOS Keychain."}
      </p>
      <div className="flex flex-wrap gap-2">
        {!status.enabled ? (
          <button className={btn} onClick={() => refresh(lock.setup())}>Require password to open…</button>
        ) : (
          <>
            <button className={btn} onClick={() => refresh(lock.lockNow())}>Lock now</button>
            <button className={btn} onClick={() => refresh(lock.change())}>Change password…</button>
            <button className={btn} onClick={() => refresh(lock.disable())}>Turn off…</button>
          </>
        )}
      </div>
    </section>
  );
}
