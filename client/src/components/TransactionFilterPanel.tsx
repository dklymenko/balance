import { type ReactNode } from "react";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { txTypeLabel, type TxType } from "@/lib/txType";
import { presetToRange, DATE_PRESET_LABELS, type DatePreset } from "@/lib/dateFilters";

interface Category { id: number; name: string; parent_id: number | null; }
interface Tag { id: number; name: string; }

// A square, multi-select-looking checkbox row.
function CheckRow({ checked, onClick, children, indent }: {
  checked: boolean; onClick: () => void; children: ReactNode; indent?: boolean;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      onClick={onClick}
      className={cn("flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted", indent && "pl-6")}
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

function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">{title}</p>
        {action}
      </div>
      {children}
    </div>
  );
}

const DATE_PRESETS: DatePreset[] = ["all", "this-month", "last-month", "last-3-months", "this-year", "custom"];
const TYPES: TxType[] = ["debit", "credit", "transfer"];

export interface TransactionFilterPanelProps {
  categories: Category[];
  allTags: Tag[];
  advanced: boolean;
  datePreset: DatePreset;
  setDatePreset: (p: DatePreset) => void;
  dateFrom: string; setDateFrom: (v: string) => void;
  dateTo: string; setDateTo: (v: string) => void;
  selectedTypes: Set<TxType>; setSelectedTypes: (s: Set<TxType>) => void;
  selectedCategoryIds: Set<number>; setSelectedCategoryIds: (s: Set<number>) => void;
  uncategorizedOnly: boolean; setUncategorizedOnly: (v: boolean) => void;
  filterTagId: string; setFilterTagId: (v: string) => void;
  amountMin: string; setAmountMin: (v: string) => void;
  amountExact: string; setAmountExact: (v: string) => void;
  amountMax: string; setAmountMax: (v: string) => void;
  recent: boolean; setRecent: (v: boolean) => void;
  onClear: () => void;
}

export default function TransactionFilterPanel(p: TransactionFilterPanelProps) {
  function choosePreset(preset: DatePreset) {
    p.setDatePreset(preset);
    if (preset === "all") { p.setDateFrom(""); p.setDateTo(""); return; }
    if (preset === "custom") return;
    const r = presetToRange(preset);
    if (r) { p.setDateFrom(r.from); p.setDateTo(r.to); }
  }

  function toggleType(t: TxType) {
    const next = new Set(p.selectedTypes);
    if (next.has(t)) next.delete(t); else next.add(t);
    p.setSelectedTypes(next);
  }

  function toggleCategory(id: number) {
    const next = new Set(p.selectedCategoryIds);
    if (next.has(id)) next.delete(id); else next.add(id);
    p.setSelectedCategoryIds(next);
  }

  // Selecting a parent toggles the parent AND all of its children together.
  function toggleGroup(parentId: number, childIds: number[]) {
    const groupIds = [parentId, ...childIds];
    const next = new Set(p.selectedCategoryIds);
    const allOn = groupIds.every((id) => next.has(id));
    for (const id of groupIds) { if (allOn) next.delete(id); else next.add(id); }
    p.setSelectedCategoryIds(next);
  }

  const parents = p.categories.filter((c) => c.parent_id === null);
  const allCatIds = p.categories.map((c) => c.id);
  const allCatsSelected = allCatIds.length > 0 && allCatIds.every((id) => p.selectedCategoryIds.has(id));
  const exactActive = p.amountExact.trim() !== "";

  return (
    <div className="space-y-5">
      {/* Amount -- first, per request: min / exact / max */}
      <Section title="Amount (USD)">
        <div className="grid grid-cols-3 gap-2">
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Min</label>
            <Input type="number" min="0" step="0.01" placeholder="0.00" disabled={exactActive}
              value={p.amountMin} onChange={(e) => p.setAmountMin(e.target.value)} />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Exact</label>
            <Input type="number" min="0" step="0.01" placeholder="Any"
              value={p.amountExact} onChange={(e) => p.setAmountExact(e.target.value)} />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Max</label>
            <Input type="number" min="0" step="0.01" placeholder="Any" disabled={exactActive}
              value={p.amountMax} onChange={(e) => p.setAmountMax(e.target.value)} />
          </div>
        </div>
      </Section>

      {/* Date */}
      <Section title="Date">
        <div className="flex flex-wrap gap-1.5">
          {DATE_PRESETS.map((preset) => (
            <button
              key={preset}
              type="button"
              onClick={() => choosePreset(preset)}
              className={cn("rounded-full border px-3 py-1 text-xs transition-colors",
                p.datePreset === preset ? "border-primary bg-primary/5 text-primary" : "border-border text-muted-foreground hover:text-foreground")}
            >
              {DATE_PRESET_LABELS[preset]}
            </button>
          ))}
        </div>
        {p.datePreset === "custom" && (
          <div className="flex items-center gap-2 pt-1">
            <Input type="date" value={p.dateFrom} onChange={(e) => p.setDateFrom(e.target.value)} className="flex-1" />
            <span className="text-xs text-muted-foreground">to</span>
            <Input type="date" value={p.dateTo} onChange={(e) => p.setDateTo(e.target.value)} className="flex-1" />
          </div>
        )}
      </Section>

      {/* Transaction Type */}
      <Section title="Transaction Type">
        <div className="space-y-0.5">
          {TYPES.map((t) => (
            <CheckRow key={t} checked={p.selectedTypes.has(t)} onClick={() => toggleType(t)}>
              {txTypeLabel(t)}
            </CheckRow>
          ))}
        </div>
      </Section>

      {/* Categories -- Select/Unselect all + parent→children cascade */}
      <Section
        title="Categories"
        action={
          <button
            type="button"
            onClick={() => p.setSelectedCategoryIds(allCatsSelected ? new Set() : new Set(allCatIds))}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            {allCatsSelected ? "Unselect all" : "Select all"}
          </button>
        }
      >
        <div className="max-h-52 space-y-0.5 overflow-y-auto rounded-md border p-1">
          <CheckRow checked={p.uncategorizedOnly} onClick={() => p.setUncategorizedOnly(!p.uncategorizedOnly)}>
            Uncategorized only
          </CheckRow>
          <div className={cn(p.uncategorizedOnly && "pointer-events-none opacity-40")}>
            {parents.map((parent) => {
              const childIds = p.categories.filter((c) => c.parent_id === parent.id).map((c) => c.id);
              const groupChecked = [parent.id, ...childIds].every((id) => p.selectedCategoryIds.has(id));
              return (
                <div key={parent.id}>
                  <CheckRow checked={groupChecked} onClick={() => toggleGroup(parent.id, childIds)}>
                    {parent.name}
                  </CheckRow>
                  {childIds.map((cid) => {
                    const child = p.categories.find((c) => c.id === cid)!;
                    return (
                      <CheckRow key={cid} indent checked={p.selectedCategoryIds.has(cid)} onClick={() => toggleCategory(cid)}>
                        {child.name}
                      </CheckRow>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      </Section>

      {/* Label */}
      {p.allTags.length > 0 && (
        <Section title="Label">
          <div className="max-h-40 space-y-0.5 overflow-y-auto rounded-md border p-1">
            <CheckRow checked={p.filterTagId === "all"} onClick={() => p.setFilterTagId("all")}>All labels</CheckRow>
            {p.allTags.map((t) => (
              <CheckRow key={t.id} checked={p.filterTagId === String(t.id)} onClick={() => p.setFilterTagId(String(t.id))}>
                {t.name}
              </CheckRow>
            ))}
          </div>
        </Section>
      )}

      {/* Recently added -- advanced only */}
      {p.advanced && (
        <Section title="Recently added">
          <CheckRow checked={p.recent} onClick={() => p.setRecent(!p.recent)}>
            Added in the last 24h
          </CheckRow>
        </Section>
      )}

      <Button variant="outline" className="w-full" onClick={p.onClear}>Clear all filters</Button>
    </div>
  );
}
