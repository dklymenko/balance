import { type ReactNode } from "react";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

// Multi-select checklist building blocks shared by the Transactions filter
// and the Reports filters, so both pick categories and labels the same way.

export interface ChecklistCategory { id: number; name: string; parent_id: number | null; }

// A square, multi-select-looking checkbox row.
export function CheckRow({ checked, onClick, children, indent }: {
  checked: boolean; onClick: () => void; children: ReactNode; indent?: boolean;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      onClick={onClick}
      className={cn("flex w-full items-center gap-2 rounded px-2 py-2 text-left text-sm transition-colors hover:bg-muted lg:py-1.5", indent && "pl-6")}
    >
      <span className={cn(
        "flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border transition-colors",
        checked ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/40",
      )}>
        {checked && <Check className="h-3 w-3" />}
      </span>
      <span className={cn("truncate", checked && "font-medium")}>{children}</span>
    </button>
  );
}

export interface CategoryGroup<C extends ChecklistCategory = ChecklistCategory> { parent: C; children: C[]; }

// Parent → children groups, both levels sorted by name. The API returns one
// flat list sorted by name, so rendering it as-is scatters sub-categories
// (ABA, ABM, Airbnb…) away from their parents. A child whose parent is
// missing is promoted to its own top-level group rather than dropped.
export function categoryGroups<C extends ChecklistCategory>(categories: C[]): CategoryGroup<C>[] {
  const byName = (a: C, b: C) => a.name.localeCompare(b.name);
  const ids = new Set(categories.map((c) => c.id));
  const parents = categories.filter((c) => c.parent_id === null || !ids.has(c.parent_id)).sort(byName);
  return parents.map((parent) => ({
    parent,
    children: categories.filter((c) => c.parent_id === parent.id).sort(byName),
  }));
}

// Hierarchical category checklist: ticking a parent ticks it AND all of its
// children; children can still be toggled one by one.
export function CategoryChecklist({ categories, selected, onChange }: {
  categories: ChecklistCategory[];
  selected: Set<number>;
  onChange: (next: Set<number>) => void;
}) {
  function toggle(id: number) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    onChange(next);
  }

  function toggleGroup(ids: number[]) {
    const next = new Set(selected);
    const allOn = ids.every((id) => next.has(id));
    for (const id of ids) { if (allOn) next.delete(id); else next.add(id); }
    onChange(next);
  }

  return (
    <>
      {categoryGroups(categories).map(({ parent, children }) => {
        const groupIds = [parent.id, ...children.map((c) => c.id)];
        return (
          <div key={parent.id}>
            <CheckRow checked={groupIds.every((id) => selected.has(id))} onClick={() => toggleGroup(groupIds)}>
              {parent.name}
            </CheckRow>
            {children.map((child) => (
              <CheckRow key={child.id} indent checked={selected.has(child.id)} onClick={() => toggle(child.id)}>
                {child.name}
              </CheckRow>
            ))}
          </div>
        );
      })}
    </>
  );
}

// Human-readable chips for a category selection: a fully-selected group
// collapses to its parent's name, otherwise each selected category is listed.
export function categorySelectionChips(categories: ChecklistCategory[], selected: Set<number>): { label: string; ids: number[] }[] {
  const chips: { label: string; ids: number[] }[] = [];
  for (const { parent, children } of categoryGroups(categories)) {
    const groupIds = [parent.id, ...children.map((c) => c.id)];
    if (children.length > 0 && groupIds.every((id) => selected.has(id))) {
      chips.push({ label: parent.name, ids: groupIds });
      continue;
    }
    for (const c of [parent, ...children]) {
      if (selected.has(c.id)) chips.push({ label: c.name, ids: [c.id] });
    }
  }
  return chips;
}
