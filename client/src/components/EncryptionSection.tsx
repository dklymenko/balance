import { useEffect, useState } from "react";
import { getDesktopEncryption, type EncryptionStatus } from "@/lib/desktopBridge";

// Encryption section of Settings -- only rendered inside the Balance Desktop
// shell, since at-rest encryption is a shell feature. Encryption is opt-in, so
// this is the permanent home for turning it on after declining the offer made
// at the end of onboarding. The key never reaches this page.
export default function EncryptionSection() {
  const encryption = getDesktopEncryption();
  const [status, setStatus] = useState<EncryptionStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getDesktopEncryption()?.status().then(setStatus).catch(() => {});
  }, []);

  if (!encryption || !status) return null;

  async function encrypt() {
    setBusy(true);
    setError(null);
    try {
      const result = await encryption!.enable();
      setStatus(result.status);
      if (!result.ok && result.error) setError(result.error);
    } catch {
      setError("Could not turn on encryption.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-2">
      <h2 className="text-sm font-medium">Encryption</h2>
      {status.encrypted ? (
        <p className="text-xs text-muted-foreground">
          This Mac's ledger is encrypted at rest. The key is protected by your macOS Keychain, and
          new snapshots are encrypted with the same key. Turning encryption off is not supported;
          export an archive if you need a portable copy.
        </p>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            Your ledger is stored unencrypted, so anything that can read your files can read it.
            Encrypting keeps the key in your macOS Keychain.{" "}
            <strong className="font-medium text-foreground">macOS asks for permission</strong> when
            you turn this on, because that is when the key is created -- choose{" "}
            <strong className="font-medium text-foreground">Always Allow</strong> to minimize future
            prompts. Unsigned source builds may ask again after a rebuild. Balance restarts its local
            server to finish, and unencrypted snapshots are replaced with an encrypted one.
          </p>
          <p className="text-xs text-muted-foreground">
            Losing the Keychain entry without an App Lock password means the ledger cannot be
            recovered, so keep an exported archive as a readable copy.
          </p>
          {error && <p role="alert" className="text-xs text-red-600">{error}</p>}
          <button
            className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
            disabled={busy}
            onClick={encrypt}
          >
            {busy ? "Working…" : "Encrypt this Mac's ledger…"}
          </button>
        </>
      )}
    </section>
  );
}
