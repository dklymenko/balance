import { useState } from "react";
import { getDesktopAmazonSession } from "@/lib/desktopBridge";

export default function AmazonSessionSection() {
  const amazonSession = getDesktopAmazonSession();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!amazonSession) return null;

  async function forget() {
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const result = await amazonSession!.forget();
      if (result.forgotten) setMessage("Amazon sign-in removed from this Mac.");
    } catch {
      setError("Could not remove the Amazon sign-in. Try again after the current match finishes.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-2">
      <h2 className="text-sm font-medium">Amazon sign-in</h2>
      <p className="text-xs text-muted-foreground">
        Balance remembers your Amazon sign-in in an isolated browser session on this Mac. Cookie
        values are encrypted using your macOS Keychain and are never synced to Balance Cloud.
      </p>
      {message && <p role="status" className="text-xs text-green-600">{message}</p>}
      {error && <p role="alert" className="text-xs text-red-600">{error}</p>}
      <button
        type="button"
        className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
        disabled={busy}
        onClick={forget}
      >
        {busy ? "Working…" : "Forget Amazon sign-in…"}
      </button>
    </section>
  );
}
