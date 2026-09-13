// Text-size preference: "default" | "compact". "default" is the larger,
// touch-friendly scale used by default; "compact"
// restores the denser earlier sizing. Scaling is done proportionally via the root
// font-size (rem-based utilities scale with it), so no per-component overrides are
// needed and layouts stay intact. Mirrors lib/theme.ts: the "default" scale carries
// no attribute; a manual "compact" choice sets data-font-size="compact" on <html>.
// The no-FOUC script in index.html applies a stored "compact" choice before first
// paint to avoid a resize flash.

export type FontSize = "default" | "compact";

const STORAGE_KEY = "balance-font-size";

export function getStoredFontSize(): FontSize {
  try {
    if (localStorage.getItem(STORAGE_KEY) === "compact") return "compact";
  } catch {
    // localStorage unavailable (private mode / SSR) → fall through to default.
  }
  return "default";
}

export function applyFontSize(size: FontSize): void {
  const root = document.documentElement;
  if (size === "compact") root.setAttribute("data-font-size", "compact");
  else root.removeAttribute("data-font-size");
}

export function setFontSize(size: FontSize): void {
  try {
    if (size === "compact") localStorage.setItem(STORAGE_KEY, "compact");
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Ignore storage failures -- still apply for the current session.
  }
  applyFontSize(size);
}
