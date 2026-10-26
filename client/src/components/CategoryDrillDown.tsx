import { useEffect, useState } from "react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { useMediaQuery } from "@/lib/useMediaQuery";

const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const USD_CENTS = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

export interface DrillDownCategory { id: number; name: string; parent_id: number | null }

// The category a drill-down was opened on: a top-level category (with its
// children), a single sub-category, or Uncategorized (id null).
export interface DrillDownTarget { id: number | null; name: string }

export interface DrillDownRow {
  id: number;
  date: string;
  description: string;
  amount_usd: number;
  category_id: number | null;
  account_name: string;
}

export interface DrillDownGroup { key: string; name: string; total: number; rows: DrillDownRow[] }

// Category ids a drill-down covers: the category itself plus its children.
export function drillDownCategoryIds(target: DrillDownTarget, categories: DrillDownCategory[]): number[] {
  if (target.id === null) return [];
  return [target.id, ...categories.filter((c) => c.parent_id === target.id).map((c) => c.id)];
}

// Group the rows by sub-category, biggest subtotal first; rows keep the
// server's newest-first order. Spend booked on the parent itself becomes
// its own "<Parent> (general)" group beside the children.
export function groupDrillDown(rows: DrillDownRow[], target: DrillDownTarget, categories: DrillDownCategory[]): DrillDownGroup[] {
  const names = new Map(categories.map((c) => [c.id, c.name]));
  const hasChildren = target.id !== null && categories.some((c) => c.parent_id === target.id);
  const groups = new Map<string, DrillDownGroup>();
  for (const row of rows) {
    const key = String(row.category_id);
    let group = groups.get(key);
    if (!group) {
      const name = row.category_id === target.id
        ? (hasChildren ? `${target.name} (general)` : target.name)
        : names.get(row.category_id ?? -1) ?? "Uncategorized";
      group = { key, name, total: 0, rows: [] };
      groups.set(key, group);
    }
    group.total += row.amount_usd;
    group.rows.push(row);
  }
  return [...groups.values()].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
}

function formatDay(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

// Transactions behind one Spend by Category row. A side panel on desktop,
// a sheet dropping from the top on narrow windows; the list is the panel's only scroll area.
export default function CategoryDrillDown({ target, onClose, start, end, accountIds, tagIds, categories, rangeLabel }: {
  target: DrillDownTarget | null;
  onClose: () => void;
  start: string; end: string;
  accountIds: Set<number>; tagIds: Set<number>;
  categories: DrillDownCategory[];
  rangeLabel: string;
}) {
  const isDesktop = useMediaQuery("(min-width: 1024px)");
  const [rows, setRows] = useState<DrillDownRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ids = target ? drillDownCategoryIds(target, categories).join(",") : "";
  useEffect(() => {
    if (!target) return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({ start, end });
    if (target.id === null) params.set("uncategorized", "1"); else params.set("category_ids", ids);
    if (accountIds.size) params.set("account_ids", [...accountIds].join(","));
    if (tagIds.size) params.set("tag_ids", [...tagIds].join(","));
    void (async () => {
      try {
        const res = await fetch(`/api/reports/spend-by-category/transactions?${params}`, { signal: controller.signal });
        if (!res.ok) throw new Error(`Request failed (${res.status})`);
        const data: unknown = await res.json();
        if (!Array.isArray(data)) throw new Error("Invalid response");
        setRows(data as DrillDownRow[]);
      } catch {
        if (!controller.signal.aborted) setError("Couldn't load these transactions.");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [target, ids, start, end, accountIds, tagIds]);

  const groups = target ? groupDrillDown(rows, target, categories) : [];
  const total = groups.reduce((s, g) => s + g.total, 0);
  const showGroupHeaders = groups.length > 1 || (target !== null && drillDownCategoryIds(target, categories).length > 1);

  return (
    <Sheet open={target !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      {/* Narrow windows: drops down from the top, like the filter pickers,
          rather than a sheet pinned to the bottom edge. */}
      <SheetContent side={isDesktop ? "right" : "top"}
        className={isDesktop
          ? "flex w-full flex-col gap-0 p-0 sm:max-w-lg"
          : "top-[env(safe-area-inset-top)] flex max-h-[85vh] flex-col gap-0 overflow-hidden p-0"}>
        <SheetHeader className="space-y-0.5 border-b border-border px-4 py-3 pr-12 text-left">
          <SheetTitle className="truncate">{target?.name}</SheetTitle>
          <SheetDescription>
            {loading ? "Loading…" : `${USD.format(total)} · ${rows.length} transaction${rows.length === 1 ? "" : "s"} · ${rangeLabel}`}
          </SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {error ? (
            <p role="alert" className="p-4 text-sm text-red-600">{error}</p>
          ) : loading ? (
            <div className="space-y-2 p-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-10 w-full" />)}</div>
          ) : rows.length === 0 ? (
            <p className="p-8 text-center text-sm text-muted-foreground">No transactions.</p>
          ) : (
            groups.map((g) => (
              <section key={g.key}>
                {showGroupHeaders && (
                  <div className="sticky top-0 z-10 flex items-baseline justify-between gap-2 border-b border-border bg-secondary px-4 py-2 text-sm">
                    <span className="truncate font-medium">{g.name}</span>
                    <span className="shrink-0 tabular-nums">
                      <span className="font-semibold">{USD.format(g.total)}</span>
                      <span className="ml-2 text-xs text-muted-foreground">{total ? `${Math.round((g.total / total) * 100)}%` : ""}</span>
                    </span>
                  </div>
                )}
                <ul className="divide-y divide-border">
                  {g.rows.map((r) => (
                    <li key={r.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                      <div className="min-w-0">
                        <p className="truncate text-sm">{r.description || "--"}</p>
                        <p className="truncate text-xs text-muted-foreground">{formatDay(r.date)} · {r.account_name}</p>
                      </div>
                      <span className="shrink-0 text-sm tabular-nums">{USD_CENTS.format(r.amount_usd)}</span>
                    </li>
                  ))}
                </ul>
              </section>
            ))
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
