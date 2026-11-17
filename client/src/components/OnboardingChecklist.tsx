import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Check, ChevronRight, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  isOnboardingStarted, markOnboardingStarted,
  isOnboardingDismissed, dismissOnboarding,
  isReportViewed,
} from "@/lib/onboarding";
import { loadSampleData, type SampleDataset } from "@/lib/sampleData";

interface Props {
  accountCount: number;
  transactionCount: number;
  isCloudProfile: boolean;
  // Parent refreshes accounts + ledger after the sample dataset lands.
  onSampleLoaded: () => void;
}

// Guided first-run checklist: the three steps to a first populated report,
// plus a one-click sample dataset for new users who want to see reports before
// entering their own data. Rendered by the Transactions home page for empty households;
// disappears for good once every step is done or it is dismissed.
export default function OnboardingChecklist({ accountCount, transactionCount, isCloudProfile, onSampleLoaded }: Props) {
  const [dismissed, setDismissed] = useState(isOnboardingDismissed);
  // Read once per mount: completing step 3 counts on the next visit, which is
  // fine -- the point is persistence, not live tracking of another tab.
  const [reportViewed] = useState(isReportViewed);
  const [seeding, setSeeding] = useState<SampleDataset | null>(null);
  const [error, setError] = useState<string | null>(null);

  const hasAccount = accountCount > 0;
  const hasTx = transactionCount > 0;
  const allDone = hasAccount && hasTx && reportViewed;

  // Only greet genuinely new households. A household that already has data the
  // first time this renders never sees the checklist.
  const populatedCloudProfile = isCloudProfile && hasAccount && hasTx;
  const eligible = !populatedCloudProfile && (isOnboardingStarted() || !(hasAccount && hasTx));
  useEffect(() => {
    if (eligible && !dismissed && !allDone) markOnboardingStarted();
  }, [eligible, dismissed, allDone]);

  if (!eligible || dismissed || allDone) return null;

  async function loadSample(dataset: SampleDataset) {
    setSeeding(dataset);
    setError(null);
    const result = await loadSampleData(dataset);
    setSeeding(null);
    if (result.ok) {
      onSampleLoaded();
      return;
    }
    setError(result.error);
    // A 400 means the ledger is not actually empty -- this window is
    // stale (data arrived after it loaded). Resync so the real ledger
    // shows and the checklist re-evaluates.
    if (result.status === 400) onSampleLoaded();
  }

  const steps = [
    { done: hasAccount, label: "Add your first account", to: "/accounts" },
    { done: hasTx, label: "Add or import transactions", to: "/transactions" },
    { done: reportViewed, label: "View your first report", to: "/reports" },
  ];

  return (
    <section className="mb-4 rounded-lg border bg-card p-4 space-y-3" aria-label="Getting started">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold">Welcome to Balance</h2>
          <p className="text-sm text-muted-foreground">Three steps to your first insight.</p>
        </div>
        <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0 text-muted-foreground"
          aria-label="Dismiss getting started" onClick={() => { dismissOnboarding(); setDismissed(true); }}>
          <X className="h-4 w-4" />
        </Button>
      </div>

      <ol className="space-y-1.5">
        {steps.map((step, i) => (
          <li key={step.label}>
            <Link to={step.to}
              className={cn(
                "flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm hover:bg-muted",
                step.done && "text-muted-foreground line-through"
              )}>
              <span className={cn(
                "flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold",
                step.done ? "border-green-600 bg-green-600 text-white" : "text-muted-foreground"
              )}>
                {step.done ? <Check className="h-3 w-3" /> : i + 1}
              </span>
              {step.label}
              {!step.done && <ChevronRight className="ml-auto h-4 w-4 text-muted-foreground" />}
            </Link>
          </li>
        ))}
      </ol>

      {!hasAccount && (
        <div className="border-t pt-3 space-y-1">
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" disabled={seeding !== null} onClick={() => loadSample("starter")}>
              {seeding === "starter" ? "Loading sample data…" : "Or explore with sample data"}
            </Button>
            <Button variant="ghost" size="sm" disabled={seeding !== null} onClick={() => loadSample("extended")}>
              {seeding === "extended" ? "Loading 3 years…" : "Try 3 years of history"}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Fills this household with demo accounts and three months of transactions,
            or three years for year-over-year reports. Remove it any time via
            Settings → Danger zone.
          </p>
          {error && <p className="text-xs text-red-600">{error}</p>}
        </div>
      )}
    </section>
  );
}
