import { useEffect, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getDesktopEncryption, type EncryptionStatus } from "@/lib/desktopBridge";
import { isOnboardingDismissed, isReportViewed } from "@/lib/onboarding";

interface Props {
  // There has to be a ledger worth protecting before the offer makes sense.
  hasLedgerData: boolean;
}

// Offers at-rest encryption once onboarding is done. Encryption is opt-in, so
// this is the moment the app first asks for the macOS Keychain -- the copy
// below exists so that prompt is expected rather than alarming. Declining is
// remembered; Settings > Encryption can still turn it on later.
export default function EncryptionPrompt({ hasLedgerData }: Props) {
  const encryption = getDesktopEncryption();
  const [status, setStatus] = useState<EncryptionStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Read once per mount, matching OnboardingChecklist: wait until the
  // getting-started card is finished or dismissed so the two never stack.
  const [checklistDone] = useState(() => isReportViewed() || isOnboardingDismissed());

  useEffect(() => {
    getDesktopEncryption()?.status().then(setStatus).catch(() => {});
  }, []);

  if (!encryption || !status || !hasLedgerData || !checklistDone) return null;
  if (status.encrypted || status.declined) return null;

  async function encrypt() {
    setBusy(true);
    setError(null);
    try {
      const result = await encryption!.enable();
      setStatus(result.status);
      // A cancelled dialog reports ok: false with no error; that is not a
      // failure worth showing.
      if (!result.ok && result.error) setError(result.error);
    } catch {
      setError("Could not turn on encryption.");
    } finally {
      setBusy(false);
    }
  }

  async function notNow() {
    setBusy(true);
    try {
      setStatus(await encryption!.decline());
    } catch {
      setError("Could not save that choice.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mb-4 rounded-lg border bg-card p-4 space-y-3" aria-label="Protect your ledger">
      <div className="flex items-start gap-3">
        <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div className="space-y-1">
          <h2 className="text-base font-semibold">Protect your ledger on this Mac</h2>
          <p className="text-sm text-muted-foreground">
            Your ledger is currently stored unencrypted, so anything that can read your files
            can read it. Balance can encrypt it and keep the key in your macOS Keychain.
          </p>
          <p className="text-sm text-muted-foreground">
            <strong className="font-medium text-foreground">macOS will ask for permission</strong> right
            after you choose this, because that is when the key is created. Choose{" "}
            <strong className="font-medium text-foreground">Always Allow</strong> to minimize future
            prompts. Unsigned source builds may ask again after a rebuild.
          </p>
          <p className="text-xs text-muted-foreground">
            Balance restarts its local server to finish, and unencrypted snapshots are replaced with an
            encrypted one. If you lose the Keychain entry and have not set an App Lock password, the
            ledger cannot be recovered, so keep an exported archive if you want a copy you can always read.
          </p>
        </div>
      </div>
      {error && <p role="alert" className="text-xs text-red-600">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={busy} onClick={encrypt}>
          {busy ? "Working…" : "Encrypt my ledger"}
        </Button>
        <Button variant="ghost" size="sm" disabled={busy} onClick={notNow}>
          Not now
        </Button>
      </div>
    </section>
  );
}
