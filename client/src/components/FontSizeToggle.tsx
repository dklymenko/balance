import { useEffect, useState } from "react";
import { getStoredFontSize, setFontSize, type FontSize } from "@/lib/fontSize";
import { useT } from "@/lib/i18n";

const OPTIONS: FontSize[] = ["default", "compact"];

// Default / Compact segmented control for the app-wide text size. Matches the
// ThemeToggle styling. Persists the choice and applies it immediately.
export default function FontSizeToggle() {
  const t = useT();
  const [size, setSizeState] = useState<FontSize>("default");

  useEffect(() => {
    setSizeState(getStoredFontSize());
  }, []);

  function choose(s: FontSize) {
    setFontSize(s);
    setSizeState(s);
  }

  return (
    <div role="radiogroup" aria-label="Text size" className="inline-flex rounded-lg border border-border p-0.5 text-sm">
      {OPTIONS.map((value) => {
        const active = size === value;
        return (
          <button
            key={value}
            role="radio"
            aria-checked={active}
            onClick={() => choose(value)}
            className={
              "rounded-md px-3 py-1 transition-colors " +
              (active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")
            }
          >
            {t(`fontSize.${value}`)}
          </button>
        );
      })}
    </div>
  );
}
