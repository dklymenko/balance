import { useState } from "react";
import { Plus, X } from "lucide-react";

export interface FabAction {
  label: string;
  onClick: () => void;
}

// Floating action button → speed dial. A coral circle with a white "+" that
// expands into labelled pills; the icon morphs to an "×" while open. Sits above
// the mobile tab bar (safe-area aware). Mobile-first: hidden on ≥md where the
// page header carries the toolbar.
export default function Fab({ actions, label = "Add" }: { actions: FabAction[]; label?: string }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="fixed right-4 bottom-[calc(4.75rem+env(safe-area-inset-bottom))] z-50 flex flex-col items-end gap-2 md:hidden">
      {open &&
        actions.map((a) => (
          <button
            key={a.label}
            onClick={() => { setOpen(false); a.onClick(); }}
            className="rounded-full border border-border bg-card px-4 py-2 text-sm font-medium shadow-lg"
          >
            {a.label}
          </button>
        ))}
      <button
        aria-label={open ? "Close" : label}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex h-14 w-14 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg transition-transform active:scale-95"
      >
        {open ? <X className="h-6 w-6" /> : <Plus className="h-6 w-6" />}
      </button>
    </div>
  );
}
