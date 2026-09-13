// Theme preference: "light" | "dark" | "system". "system" follows
// prefers-color-scheme (no data-theme attribute, CSS media query governs); a
// manual choice sets data-theme on <html>. The no-FOUC script in index.html
// applies a stored manual choice before first paint; this module keeps the
// attribute and localStorage in sync at runtime.

export type Theme = "light" | "dark" | "system";

const STORAGE_KEY = "balance-theme";
export const THEME_CHANGED_EVENT = "balance:theme-changed";

export function getStoredTheme(): Theme {
  try {
    const t = localStorage.getItem(STORAGE_KEY);
    if (t === "light" || t === "dark") return t;
  } catch {
    // localStorage unavailable (private mode / SSR) → fall through to system.
  }
  return "system";
}

export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
}

export function setTheme(theme: Theme): void {
  try {
    if (theme === "system") localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Ignore storage failures -- still apply for the current session.
  }
  applyTheme(theme);
  // The header and Settings each render their own control. Storage events do
  // not fire in the document that made the change, so notify sibling controls
  // explicitly as well as persisting for future windows and launches.
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent<Theme>(THEME_CHANGED_EVENT, { detail: theme }));
  }
}
