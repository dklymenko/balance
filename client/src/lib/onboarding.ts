// Per-browser first-run checklist state (same localStorage pattern as
// features.ts). Three flags:
// - started: the checklist greeted this browser while the household was still
//   empty -- households that already had data never see it.
// - report viewed: step 3, set by the Reports page on first visit.
// - dismissed: the user closed the checklist for good.

const STARTED_KEY = "balance-onboarding-started";
const DISMISSED_KEY = "balance-onboarding-dismissed";
const REPORT_VIEWED_KEY = "balance-report-viewed";

function get(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function set(key: string): void {
  try {
    localStorage.setItem(key, "1");
  } catch {
    // storage unavailable -- the checklist just re-evaluates next load
  }
}

export const isOnboardingStarted = () => get(STARTED_KEY);
export const markOnboardingStarted = () => set(STARTED_KEY);

export const isOnboardingDismissed = () => get(DISMISSED_KEY);
export const dismissOnboarding = () => set(DISMISSED_KEY);

export const isReportViewed = () => get(REPORT_VIEWED_KEY);
export const markReportViewed = () => set(REPORT_VIEWED_KEY);
