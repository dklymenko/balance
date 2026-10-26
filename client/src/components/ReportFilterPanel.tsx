import { type ReactNode } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import AccountFilter, { type FilterableAccount } from "@/components/AccountFilter";
import { CategoryChecklist, CheckRow, categorySelectionChips, type ChecklistCategory } from "@/components/FilterChecklist";

export interface ReportTag { id: number; name: string }

// The filter dimensions a report opts into. Accounts are always offered.
export interface ReportFilterState {
  accountIds: Set<number>;
  categoryIds: Set<number>;
  tagIds: Set<number>;
}

export interface ReportFilterPanelProps {
  accounts: FilterableAccount[];
  categories: ChecklistCategory[];
  tags: ReportTag[];
  showCategories: boolean;
  showTags: boolean;
  value: ReportFilterState;
  onChange: (next: ReportFilterState) => void;
  // Desktop rail: cap each list so the rail stays a sidebar, not a page.
  compact?: boolean;
}

function Section({ title, onClear, children }: { title: string; onClear?: () => void; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">{title}</p>
        {onClear
          ? <button type="button" onClick={onClear} className="text-xs text-muted-foreground hover:text-foreground">Clear</button>
          : <span className="text-xs text-muted-foreground">All</span>}
      </div>
      {children}
    </div>
  );
}

// Same pickers as the Transactions filter: grouped accounts, hierarchical
// categories (a parent toggles its whole group) and labels. An empty
// selection means "everything".
export default function ReportFilterPanel(p: ReportFilterPanelProps) {
  const { value, onChange } = p;
  const listClass = cn("space-y-0.5", p.compact && "max-h-72 overflow-y-auto rounded-md border border-border p-1");

  function toggleTag(id: number) {
    const next = new Set(value.tagIds);
    if (next.has(id)) next.delete(id); else next.add(id);
    onChange({ ...value, tagIds: next });
  }

  return (
    <div className="space-y-5">
      <AccountFilter accounts={p.accounts} selected={value.accountIds} onChange={(accountIds) => onChange({ ...value, accountIds })} />

      {p.showCategories && p.categories.length > 0 && (
        <Section title="Categories" onClear={value.categoryIds.size > 0 ? () => onChange({ ...value, categoryIds: new Set() }) : undefined}>
          <div className={listClass}>
            <CategoryChecklist categories={p.categories} selected={value.categoryIds}
              onChange={(categoryIds) => onChange({ ...value, categoryIds })} />
          </div>
        </Section>
      )}

      {p.showTags && p.tags.length > 0 && (
        <Section title="Labels" onClear={value.tagIds.size > 0 ? () => onChange({ ...value, tagIds: new Set() }) : undefined}>
          <div className={listClass}>
            {p.tags.map((t) => (
              <CheckRow key={t.id} checked={value.tagIds.has(t.id)} onClick={() => toggleTag(t.id)}>{t.name}</CheckRow>
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}

// Removable chips summarising the active filters, so a filter applied in the
// mobile sheet stays visible (and one tap away from removal) on the report.
export function ReportFilterChips({ accounts, categories, tags, showCategories, showTags, value, onChange }: Omit<ReportFilterPanelProps, "compact">) {
  const chips: { key: string; label: string; remove: () => void }[] = [];
  for (const a of accounts) {
    if (!value.accountIds.has(a.id)) continue;
    chips.push({ key: `a${a.id}`, label: a.name, remove: () => {
      const next = new Set(value.accountIds); next.delete(a.id); onChange({ ...value, accountIds: next });
    } });
  }
  if (showCategories) {
    for (const c of categorySelectionChips(categories, value.categoryIds)) {
      chips.push({ key: `c${c.ids.join("-")}`, label: c.label, remove: () => {
        const next = new Set(value.categoryIds); for (const id of c.ids) next.delete(id); onChange({ ...value, categoryIds: next });
      } });
    }
  }
  if (showTags) {
    for (const t of tags) {
      if (!value.tagIds.has(t.id)) continue;
      chips.push({ key: `t${t.id}`, label: `#${t.name}`, remove: () => {
        const next = new Set(value.tagIds); next.delete(t.id); onChange({ ...value, tagIds: next });
      } });
    }
  }
  if (chips.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {chips.map((c) => (
        <span key={c.key} className="inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-secondary/60 py-0.5 pl-2.5 pr-1 text-xs">
          <span className="truncate">{c.label}</span>
          <button type="button" onClick={c.remove} aria-label={`Remove ${c.label}`}
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground">
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
    </div>
  );
}

// Number of active filters for the given dimensions (the badge count); a
// fully-selected category group counts once, matching its single chip.
export function activeFilterCount(value: ReportFilterState, categories: ChecklistCategory[], showCategories: boolean, showTags: boolean): number {
  return value.accountIds.size
    + (showCategories ? categorySelectionChips(categories, value.categoryIds).length : 0)
    + (showTags ? value.tagIds.size : 0);
}
