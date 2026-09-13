import { useEffect, useState } from "react";
import { getStoredTheme, setTheme, THEME_CHANGED_EVENT, type Theme } from "@/lib/theme";
import { useT } from "@/lib/i18n";

const OPTIONS: Theme[] = ["light", "dark", "system"];

// Light / Dark / System segmented control. The active segment uses the brand
// coral; the others recede. Persists the choice and applies it immediately.
export default function ThemeToggle() {
  const t = useT();
  const [theme, setThemeState] = useState<Theme>("system");

  useEffect(() => {
    setThemeState(getStoredTheme());
    const syncTheme = (event: Event) => {
      const selected = event instanceof CustomEvent ? event.detail : getStoredTheme();
      if (selected === "light" || selected === "dark" || selected === "system") {
        setThemeState(selected);
      }
    };
    window.addEventListener(THEME_CHANGED_EVENT, syncTheme);
    window.addEventListener("storage", syncTheme);
    return () => {
      window.removeEventListener(THEME_CHANGED_EVENT, syncTheme);
      window.removeEventListener("storage", syncTheme);
    };
  }, []);

  function choose(t: Theme) {
    setTheme(t);
    setThemeState(t);
  }

  return (
    <div role="radiogroup" aria-label="Theme" className="inline-flex rounded-lg border border-border p-0.5 text-sm">
      {OPTIONS.map((opt) => {
        const active = theme === opt;
        return (
          <button
            key={opt}
            role="radio"
            aria-checked={active}
            onClick={() => choose(opt)}
            className={
              "rounded-md px-3 py-1 transition-colors " +
              (active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")
            }
          >
            {t(`theme.${opt}`)}
          </button>
        );
      })}
    </div>
  );
}
