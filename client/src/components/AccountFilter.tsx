import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { visibleAccounts } from "@/lib/accountVisibility";
import { ACCOUNT_GROUPS } from "@/lib/accountGroups";
import { useT } from "@/lib/i18n";

export interface FilterableAccount {
  id: number;
  name: string;
  liquidity_type: string;
  account_type: string;
  is_active?: boolean | null;
}

// Grouped, multi-select account filter shared by Transactions (persistent rail +
// slide-over drawer) and Reports (filter sheet). Multi-select is signalled with a
// square checkbox per row; "Clear" resets the selection. `onSelect` (used by the
// mobile drawer) fires after each toggle so the sheet can close.
export default function AccountFilter({
  accounts,
  selected,
  onChange,
  onSelect,
  title,
}: {
  accounts: FilterableAccount[];
  selected: Set<number>;
  onChange: (next: Set<number>) => void;
  onSelect?: () => void;
  title?: string;
}) {
  const t = useT();
  const heading = title ?? t("nav.accounts");
  function toggle(id: number) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(next);
    onSelect?.();
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">{heading}</p>
        {selected.size > 0 && (
          <button onClick={() => onChange(new Set())} className="text-xs text-muted-foreground hover:text-foreground">
            {t("common.clear")}
          </button>
        )}
      </div>
      {ACCOUNT_GROUPS.map(({ key, filter }) => {
        const group = visibleAccounts(accounts).filter(filter);
        if (group.length === 0) return null;
        return (
          <div key={key}>
            <p className="mb-1 text-xs text-muted-foreground">{t(`accountGroup.${key}`)}</p>
            <div className="space-y-0.5">
              {group.map((acc) => {
                const sel = selected.has(acc.id);
                return (
                  <button
                    key={acc.id}
                    role="checkbox"
                    aria-checked={sel}
                    onClick={() => toggle(acc.id)}
                    className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted"
                  >
                    <span className={cn(
                      "flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border transition-colors",
                      sel ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/40",
                    )}>
                      {sel && <Check className="h-3 w-3" />}
                    </span>
                    <span className={cn("truncate", sel && "font-medium")}>{acc.name}</span>
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
