import { useState, type ReactNode } from "react";
import { ChevronDown, FolderTree, Search, Tag, Wallet, X, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { type FilterableAccount } from "@/components/AccountFilter";
import { CategoryChecklist, CheckRow, categoryGroups, categorySelectionChips, type ChecklistCategory } from "@/components/FilterChecklist";
import { visibleAccounts } from "@/lib/accountVisibility";
import { ACCOUNT_GROUPS } from "@/lib/accountGroups";
import { useMediaQuery } from "@/lib/useMediaQuery";
import { useT } from "@/lib/i18n";

export interface ReportTag { id: number; name: string }

export interface ReportFilterState {
  accountIds: Set<number>;
  categoryIds: Set<number>;
  tagIds: Set<number>;
}

export interface ReportFilterBarProps {
  accounts: FilterableAccount[];
  categories: ChecklistCategory[];
  tags: ReportTag[];
  showAccounts: boolean;
  showCategories: boolean;
  showTags: boolean;
  value: ReportFilterState;
  onChange: (next: ReportFilterState) => void;
}

// One filter button + its pop-up: a popover dropping down from the button
// on every screen size (phones get a near-full-width one), so the list opens
// right where you tapped instead of in a sheet at the bottom. The pop-up body
// is the ONLY scroll area (no list scrolling inside a scrolling panel). An
// active filter shows its selection on the button and an × beside it.
function FilterButton({ icon: Icon, label, summary, count, onClear, children }: {
  icon: LucideIcon; label: string; summary: string | null; count: number;
  onClear: () => void; children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const isDesktop = useMediaQuery("(min-width: 1024px)");
  const active = count > 0;

  return (
    <div className="flex shrink-0 items-center">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button type="button" aria-label={label}
            className={cn(
              "flex h-9 min-w-0 items-center gap-1.5 rounded-full border px-3 text-sm transition-colors",
              active ? "border-primary bg-primary/10 font-medium text-primary" : "border-border text-muted-foreground hover:text-foreground",
            )}>
            <Icon className="h-4 w-4 shrink-0" />
            {/* Phones show the icon + count; wider screens add the label/summary. */}
            <span className="hidden max-w-40 truncate sm:inline">{summary ?? label}</span>
            {active && <span className="tabular-nums sm:hidden">{count}</span>}
            <ChevronDown className="hidden h-3.5 w-3.5 shrink-0 opacity-60 sm:block" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" collisionPadding={16}
          // Don't jump focus into the search box on phones: it would pop
          // the keyboard up over the list before the user asked to type.
          onOpenAutoFocus={isDesktop ? undefined : (e) => e.preventDefault()}
          className="flex max-h-[min(70vh,var(--radix-popover-content-available-height))] w-[calc(100vw-2rem)] flex-col p-0 sm:w-80">
          {/* The phone buttons are icon-only, so name the pop-up. */}
          <p className="border-b border-border px-4 py-2.5 text-sm font-semibold sm:hidden">{label}</p>
          <div className="flex min-h-0 flex-1 flex-col">
            {children}
            <div className="flex gap-2 border-t border-border p-3">
              <Button variant="outline" className="flex-1" disabled={!active} onClick={onClear}>Clear</Button>
              <Button className="flex-1" onClick={() => setOpen(false)}>Done</Button>
            </div>
          </div>
        </PopoverContent>
      </Popover>
      {active && (
        <button type="button" onClick={onClear} aria-label={`Clear ${label.toLowerCase()} filter`}
          className="ml-0.5 flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground hover:bg-secondary hover:text-foreground">
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}

function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <div className="relative border-b border-border p-3">
      <Search className="pointer-events-none absolute left-5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className="pl-8" />
    </div>
  );
}

function ScrollBody({ children }: { children: ReactNode }) {
  return <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-2">{children}</div>;
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="px-2 py-6 text-center text-sm text-muted-foreground">{children}</p>;
}

// "Trip" / "Trip, Work" / "3 selected" -- what an active button reads.
function summarize(names: string[]): string | null {
  if (names.length === 0) return null;
  if (names.length <= 2) return names.join(", ");
  return `${names.length} selected`;
}

// What a summary pill reads: "Disney 2026" / "Trip, Work" / "3 labels".
function summarizeAs(names: string[], plural: string): string | null {
  if (names.length === 0) return null;
  if (names.length <= 2) return names.join(", ");
  return `${names.length} ${plural}`;
}

// The active filters, as compact read-only pills beside a report's headline
// (Labels, Categories, Accounts -- the button order). Renders nothing when no
// filter is on, so an unfiltered report looks exactly as before. `stacked`
// puts the pills in a right-aligned column (the free space beside a big
// total); otherwise they sit in a right-aligned row that wraps.
export function ReportFilterSummary({ accounts, categories, tags, showCategories, showTags, value, stacked = false }: {
  accounts: FilterableAccount[];
  categories: ChecklistCategory[];
  tags: ReportTag[];
  showCategories: boolean;
  showTags: boolean;
  value: ReportFilterState;
  stacked?: boolean;
}) {
  const pills: { key: string; icon: LucideIcon; text: string }[] = [];
  const tagText = showTags ? summarizeAs(tags.filter((t) => value.tagIds.has(t.id)).map((t) => t.name), "labels") : null;
  if (tagText) pills.push({ key: "tags", icon: Tag, text: tagText });
  const catText = showCategories ? summarizeAs(categorySelectionChips(categories, value.categoryIds).map((c) => c.label), "categories") : null;
  if (catText) pills.push({ key: "categories", icon: FolderTree, text: catText });
  const accText = summarizeAs(visibleAccounts(accounts).filter((a) => value.accountIds.has(a.id)).map((a) => a.name), "accounts");
  if (accText) pills.push({ key: "accounts", icon: Wallet, text: accText });
  if (pills.length === 0) return null;

  return (
    <div aria-label="Active filters"
      className={cn("flex min-w-0 gap-1.5", stacked ? "max-w-[55%] flex-col items-end" : "ml-auto flex-wrap justify-end")}>
      {pills.map(({ key, icon: Icon, text }) => (
        <span key={key} title={text}
          className="inline-flex max-w-full items-center gap-1 rounded-full border border-primary/40 bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary">
          <Icon className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{text}</span>
        </span>
      ))}
    </div>
  );
}

function toggle(set: Set<number>, id: number): Set<number> {
  const next = new Set(set);
  if (next.has(id)) next.delete(id); else next.add(id);
  return next;
}

// The Labels / Categories / Accounts filter buttons a report sits under, in
// that order. An empty selection means "everything".
export default function ReportFilterBar(p: ReportFilterBarProps) {
  const t = useT();
  const { value, onChange } = p;
  const [catQuery, setCatQuery] = useState("");
  const [accQuery, setAccQuery] = useState("");

  const tagNames = p.tags.filter((tg) => value.tagIds.has(tg.id)).map((tg) => tg.name);
  const catChips = categorySelectionChips(p.categories, value.categoryIds);
  const shownAccounts = visibleAccounts(p.accounts);
  const accNames = shownAccounts.filter((a) => value.accountIds.has(a.id)).map((a) => a.name);

  // Category search keeps a whole group when its parent matches, otherwise
  // just the matching children under their parent.
  const q = catQuery.trim().toLowerCase();
  const filteredCats = q
    ? categoryGroups(p.categories).flatMap(({ parent, children }) => {
        if (parent.name.toLowerCase().includes(q)) return [parent, ...children];
        const kids = children.filter((c) => c.name.toLowerCase().includes(q));
        return kids.length ? [parent, ...kids] : [];
      })
    : p.categories;
  const aq = accQuery.trim().toLowerCase();

  return (
    <div className="ml-auto flex shrink-0 items-center gap-1.5">
      {p.showTags && p.tags.length > 0 && (
        <FilterButton icon={Tag} label="Labels" summary={summarize(tagNames)} count={value.tagIds.size}
          onClear={() => onChange({ ...value, tagIds: new Set() })}>
          <ScrollBody>
            {p.tags.map((tg) => (
              <CheckRow key={tg.id} checked={value.tagIds.has(tg.id)}
                onClick={() => onChange({ ...value, tagIds: toggle(value.tagIds, tg.id) })}>
                {tg.name}
              </CheckRow>
            ))}
          </ScrollBody>
        </FilterButton>
      )}

      {p.showCategories && p.categories.length > 0 && (
        <FilterButton icon={FolderTree} label="Categories" summary={summarize(catChips.map((c) => c.label))} count={catChips.length}
          onClear={() => onChange({ ...value, categoryIds: new Set() })}>
          <SearchBox value={catQuery} onChange={setCatQuery} placeholder="Search categories" />
          <ScrollBody>
            {filteredCats.length > 0
              ? <CategoryChecklist categories={filteredCats} selected={value.categoryIds}
                  onChange={(categoryIds) => onChange({ ...value, categoryIds })} />
              : <Empty>No categories match.</Empty>}
          </ScrollBody>
        </FilterButton>
      )}

      {p.showAccounts && (
        <FilterButton icon={Wallet} label="Accounts" summary={summarize(accNames)} count={accNames.length}
          onClear={() => onChange({ ...value, accountIds: new Set() })}>
          {shownAccounts.length > 8 && <SearchBox value={accQuery} onChange={setAccQuery} placeholder="Search accounts" />}
          <ScrollBody>
            {ACCOUNT_GROUPS.map(({ key, filter }) => {
              const group = shownAccounts.filter(filter).filter((a) => !aq || a.name.toLowerCase().includes(aq));
              if (group.length === 0) return null;
              return (
                <div key={key} className="pb-1">
                  <p className="px-2 pb-0.5 pt-2 text-xs text-muted-foreground">{t(`accountGroup.${key}`)}</p>
                  {group.map((a) => (
                    <CheckRow key={a.id} checked={value.accountIds.has(a.id)}
                      onClick={() => onChange({ ...value, accountIds: toggle(value.accountIds, a.id) })}>
                      {a.name}
                    </CheckRow>
                  ))}
                </div>
              );
            })}
          </ScrollBody>
        </FilterButton>
      )}
    </div>
  );
}
