import { useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, ChevronLeft, ChevronRight, Filter, TrendingDown, TrendingUp, Tags, BarChart3, GitCompare, type LucideIcon, Repeat } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import AccountFilter from "@/components/AccountFilter";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import {
  ResponsiveContainer, BarChart, Bar, LineChart, Line, ComposedChart, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine, ReferenceDot,
} from "recharts";
import { categoryColor } from "@/lib/categoryColors";
import PageContainer from "@/components/PageContainer";
import SubscriptionsReport from "@/components/SubscriptionsReport";
import { Skeleton } from "@/components/ui/skeleton";
import { markReportViewed } from "@/lib/onboarding";
import { useT } from "@/lib/i18n";
import { buildCategoryTree, netIncomeTrend, reportMonths, type SpendRow } from "@/lib/reportHelpers";

// Shared dark/light-aware tooltip style for every chart.
const TOOLTIP_STYLE = {
  fontSize: 13, borderRadius: 8, background: "var(--bg-surface)",
  border: "1px solid var(--border-subtle)", color: "var(--text-primary)",
  boxShadow: "0 4px 12px rgba(0,0,0,0.25)",
} as const;

// ─── Types ───────────────────────────────────────────────────────────────────

interface Account {
  id: number;
  name: string;
  liquidity_type: "Liquid" | "Invested" | "Locked";
  account_type: string;
  is_active?: boolean;
}

interface Category {
  id: number;
  name: string;
  parent_id: number | null;
}

type ReportId = "spend-by-category" | "spend-over-time" | "income-spend-savings" | "period-comparison" | "subscriptions";

const REPORTS: { id: ReportId; label: string; icon: LucideIcon }[] = [
  { id: "spend-by-category",    label: "Spend by Category", icon: Tags },
  { id: "income-spend-savings", label: "Income vs Spend",   icon: TrendingUp },
  { id: "spend-over-time",      label: "Spend Over Time",   icon: BarChart3 },
  { id: "period-comparison",    label: "Period Comparison", icon: GitCompare },
  { id: "subscriptions",        label: "Subscriptions",     icon: Repeat },
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

function ym(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function qs(params: Record<string, string>) {
  return "?" + Object.entries(params).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
}

async function fetchJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Request failed (${response.status})`);
  return response.json() as Promise<T>;
}

function ReportLoadError({ message }: { message: string }) {
  return (
    <p role="alert" className="rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
      {message}
    </p>
  );
}

function formatPeriod(p: string) {
  if (p.length === 4) return p;
  const [y, m] = p.split("-");
  return new Date(Number(y), Number(m) - 1).toLocaleString("en-US", { month: "short", year: "2-digit" });
}

// "YYYY-MM" → "Jun 2026"; "YYYY" → "2026".
function monthLabel(p: string) {
  if (p.length === 4) return p;
  const [y, m] = p.split("-").map(Number);
  return new Date(y, m - 1).toLocaleString("en-US", { month: "short", year: "numeric" });
}

// Headline range caption, e.g. "Jun 2026" or "Jan 2026 – Jun 2026".
function rangeLabel(start: string, end: string) {
  return start === end ? monthLabel(start) : `${monthLabel(start)} – ${monthLabel(end)}`;
}

// Short month label for a bar -- every bar shows its 3-letter month (the year
// lives in the headline caption), so January reads "Jan", not "2026".
function barLabel(ym: string): string {
  const m = Number(ym.split("-")[1]);
  return new Date(2000, m - 1).toLocaleString("en-US", { month: "short" });
}

// "YYYY-MM" date math for the Period-comparison report.
function shiftYm(ym: string, n: number): string {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
function monthSpan(start: string, end: string): number {
  const [ys, ms] = start.split("-").map(Number);
  const [ye, me] = end.split("-").map(Number);
  return (ye - ys) * 12 + (me - ms) + 1;
}

function firstDay(ym: string): string { return `${ym}-01`; }
function lastDay(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  return `${ym}-${String(new Date(y, m, 0).getDate()).padStart(2, "0")}`;
}

// Whole-month span of a [start, end] "YYYY-MM" range, inclusive.
function monthsInRange(start: string, end: string): number {
  const [sy, sm] = start.split("-").map(Number);
  const [ey, em] = end.split("-").map(Number);
  if (![sy, sm, ey, em].every(Number.isFinite)) return 1;
  return Math.max(1, (ey - sy) * 12 + (em - sm) + 1);
}

function toggleSet(prev: Set<number>, id: number): Set<number> {
  const next = new Set(prev);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

// ─── Period selector (Spend by Category) ─────────────────────────────────────

type Period = "this-month" | "last-month" | "3m" | "6m" | "1y" | "3y" | "this-year" | "last-year" | "all" | "custom";

// Period labels are translated at the call site via t(`period.${p}`).

// Which period chips each report offers.
const PERIOD_OPTIONS: Record<ReportId, Period[]> = {
  "income-spend-savings": ["this-month", "last-month", "3m", "6m", "this-year", "last-year"],
  "spend-by-category":    ["this-month", "last-month", "3m", "6m", "this-year", "last-year"],
  "spend-over-time":      ["this-month", "last-month", "3m", "6m", "this-year", "last-year"],
  "period-comparison":    ["this-month", "last-month", "3m", "1y", "custom"],
  // Subscriptions is periodless: detection always scans the whole ledger.
  "subscriptions":        [],
};

function periodToRange(p: Exclude<Period, "custom">): { start: string; end: string } {
  const now = new Date();
  const thisMonth = ym(now);
  const offset = (n: number) => { const d = new Date(now); d.setMonth(d.getMonth() + n); return ym(d); };

  switch (p) {
    case "this-month": return { start: thisMonth, end: thisMonth };
    case "last-month": return { start: offset(-1), end: offset(-1) };
    case "3m":         return { start: offset(-2),  end: thisMonth };
    case "6m":         return { start: offset(-5),  end: thisMonth };
    case "1y":         return { start: offset(-11), end: thisMonth };
    case "3y":         return { start: offset(-35), end: thisMonth };
    case "this-year":  return { start: `${now.getFullYear()}-01`,     end: thisMonth };
    case "last-year":  return { start: `${now.getFullYear() - 1}-01`, end: `${now.getFullYear() - 1}-12` };
    case "all":        return { start: "2000-01",   end: thisMonth };
  }
}

// ─── MonthYearPicker (Custom period) ─────────────────────────────────────────

const MONTH_LABELS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function MonthYearPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const [selY, selM] = value.split("-").map(Number);
  const [viewYear, setViewYear] = useState<number>(Number.isFinite(selY) ? selY : new Date().getFullYear());

  const label = Number.isFinite(selY) && Number.isFinite(selM)
    ? new Date(selY, selM - 1).toLocaleString("en-US", { month: "short", year: "numeric" })
    : "Pick month";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 justify-between gap-2 font-normal">
          <span>{label}</span>
          <ChevronDown className="h-3.5 w-3.5 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-3" align="start">
        <div className="mb-2 flex items-center justify-between">
          <Button aria-label="Previous year" variant="ghost" size="icon" className="h-7 w-7" onClick={() => setViewYear(y => y - 1)}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="text-sm font-medium tabular-nums">{viewYear}</span>
          <Button aria-label="Next year" variant="ghost" size="icon" className="h-7 w-7" onClick={() => setViewYear(y => y + 1)}>
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
        <div className="grid grid-cols-3 gap-1">
          {MONTH_LABELS.map((m, i) => {
            const monthNum = i + 1;
            const isSelected = viewYear === selY && monthNum === selM;
            return (
              <button key={m}
                onClick={() => { onChange(`${viewYear}-${String(monthNum).padStart(2, "0")}`); setOpen(false); }}
                className={cn("rounded-md py-1.5 text-sm transition-colors", isSelected ? "bg-primary text-primary-foreground" : "hover:bg-muted")}>
                {m}
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ─── IncludePicker ───────────────────────────────────────────────────────────
// Plain multi-select checkbox list: the chosen items are included; when none are
// chosen, everything is shown.

function IncludePicker({ title, items, selected, onChange }: {
  title: string;
  items: { id: number; name: string; indent?: boolean }[];
  selected: Set<number>;
  onChange: (s: Set<number>) => void;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <span className="shrink-0 text-xs font-medium uppercase tracking-widest text-muted-foreground">{title}</span>
        {selected.size > 0
          ? <button onClick={() => onChange(new Set())} className="text-xs text-muted-foreground hover:text-foreground">Clear</button>
          : <span className="text-xs text-muted-foreground">All</span>}
      </div>
      <div className="max-h-44 space-y-0.5 overflow-y-auto">
        {items.map(item => {
          const sel = selected.has(item.id);
          return (
            <button
              key={item.id}
              type="button"
              role="checkbox"
              aria-checked={sel}
              onClick={() => onChange(toggleSet(selected, item.id))}
              className={cn("flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm transition-colors hover:bg-muted", item.indent && "pl-6")}
            >
              <span className={cn(
                "flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border transition-colors",
                sel ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/40",
              )}>
                {sel && <Check className="h-3 w-3" />}
              </span>
              <span className={cn("truncate", item.indent && "text-muted-foreground")}>{item.name}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ─── Spend by Category ───────────────────────────────────────────────────────

function SpendByCategory({ start, end, accountIds, rangeLabel, categories }: {
  start: string; end: string; accountIds: Set<number>; rangeLabel: string; categories: Category[];
}) {
  const t = useT();
  const [rows, setRows] = useState<SpendRow[]>([]);
  const [expanded, setExpanded] = useState<Set<number | null>>(new Set());
  const [view, setView] = useState<"chart" | "table">("chart");
  const [amountMode, setAmountMode] = useState<"total" | "average">("total");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    const params = qs({ start, end, account_ids: [...accountIds].join(",") });
    void fetchJson<unknown>(`/api/reports/spend-by-category${params}`, controller.signal)
      .then((data) => {
        if (!Array.isArray(data)) throw new Error("Invalid report response");
        setRows(data);
      })
      .catch(() => {
        if (!controller.signal.aborted) setError("Couldn't load spending report.");
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [start, end, accountIds]);

  const tree = useMemo(() => buildCategoryTree(rows, categories), [rows, categories]);
  const grandTotal = tree.reduce((s, n) => s + n.total, 0);

  // Total vs. average-per-month. The toggle only makes sense across >1 month; a
  // uniform divisor keeps every share-of-total percentage unchanged.
  const months = monthsInRange(start, end);
  const divisor = amountMode === "average" && months > 1 ? months : 1;
  const fmt = (v: number) => USD.format(v / divisor);

  // Stable colour per top-level category (by spend rank).
  const colored = tree.map((node, i) => ({ node, color: categoryColor(i) }));

  function toggle(id: number | null) {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  if (error) return <ReportLoadError message={error} />;

  return (
    <div className="space-y-4">
      {/* Headline */}
      <div>
        {loading ? (
          <Skeleton className="h-9 w-40" />
        ) : (
          <p className="text-3xl font-bold leading-tight tabular-nums">{fmt(grandTotal)}</p>
        )}
        <p className="text-sm text-muted-foreground">
          {rangeLabel}{amountMode === "average" && months > 1 ? " · average / month" : ""}
        </p>
      </div>

      {/* View switch + Total/Average toggle (average only when spanning >1 month) */}
      <div className="flex flex-wrap items-center gap-2">
        <div role="radiogroup" aria-label="View" className="inline-flex rounded-lg border border-border p-0.5 text-sm">
          {(["chart", "table"] as const).map(v => (
            <button key={v} role="radio" aria-checked={view === v} onClick={() => setView(v)}
              className={cn("rounded-md px-3 py-1 transition-colors",
                view === v ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}>
              {v === "chart" ? t("reports.chart") : t("reports.table")}
            </button>
          ))}
        </div>
        {months > 1 && (
          <div role="radiogroup" aria-label="Amount mode" className="inline-flex rounded-lg border border-border p-0.5 text-sm">
            {(["total", "average"] as const).map(m => (
              <button key={m} role="radio" aria-checked={amountMode === m} onClick={() => setAmountMode(m)}
                className={cn("rounded-md px-3 py-1 transition-colors",
                  amountMode === m ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}>
                {t(`reports.${m}`)}
              </button>
            ))}
          </div>
        )}
      </div>

      {loading ? (
        <div className="h-44 animate-pulse rounded-lg bg-secondary" />
      ) : !tree.length ? (
        <div className="rounded-lg border border-border p-8 text-center text-sm text-muted-foreground">
          {t("reports.noSpend")}
        </div>
      ) : view === "chart" ? (
        <div>
          {/* Ranked category list with proportional bars (single column;
              the grand total is already the headline above, so no donut) */}
          <div className="space-y-1">
            {colored.map(({ node, color }) => {
              const pct = grandTotal ? (node.total / grandTotal) * 100 : 0;
              const hasChildren = node.children.length > 0;
              const isExpanded = expanded.has(node.id);
              return (
                <div key={node.id}>
                  <button onClick={() => hasChildren && toggle(node.id)}
                    className={cn("w-full rounded-lg px-2 py-2 text-left", hasChildren && "hover:bg-secondary")}>
                    <div className="flex items-center gap-3">
                      <span className="h-3 w-3 shrink-0 rounded-full" style={{ background: color }} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate text-sm font-medium">{node.name}</span>
                          <span className="shrink-0 text-sm tabular-nums">{fmt(node.total)}</span>
                        </div>
                        <div className="mt-1.5 flex items-center gap-2">
                          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-secondary">
                            <div className="h-full rounded-full" style={{ width: `${pct}%`, background: color }} />
                          </div>
                          <span className="w-9 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{pct.toFixed(0)}%</span>
                        </div>
                      </div>
                      {hasChildren && (isExpanded
                        ? <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                        : <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />)}
                    </div>
                  </button>
                  {hasChildren && isExpanded && (
                    <div className="ml-6 space-y-1 border-l border-border pl-3">
                      {node.children.map(child => {
                        const cpct = grandTotal ? (child.total / grandTotal) * 100 : 0;
                        return (
                          <div key={child.id} className="flex items-center justify-between gap-2 py-1 pr-2">
                            <span className="truncate text-sm text-muted-foreground">{child.name}</span>
                            <span className="shrink-0 text-sm tabular-nums text-muted-foreground">
                              {fmt(child.total)} · {cpct.toFixed(0)}%
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        /* Table view -- the raw numbers, for power users and screen readers. */
        <div className="overflow-hidden rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-secondary">
              <tr>
                <th className="px-4 py-2 text-left font-medium">Category</th>
                <th className="px-4 py-2 text-right font-medium">Amount</th>
                <th className="px-4 py-2 text-right font-medium text-muted-foreground">%</th>
              </tr>
            </thead>
            <tbody>
              {tree.map(node => {
                const isExpanded = expanded.has(node.id);
                const hasChildren = node.children.length > 0;
                return [
                  <tr key={`p-${node.id}`}
                    className={cn("border-t border-border", hasChildren && "cursor-pointer hover:bg-secondary")}
                    onClick={() => hasChildren && toggle(node.id)}>
                    <td className="flex items-center gap-1.5 px-4 py-2 font-medium">
                      {hasChildren
                        ? (isExpanded ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />)
                        : <span className="w-3.5" />}
                      {node.name}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">{fmt(node.total)}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">
                      {grandTotal ? `${((node.total / grandTotal) * 100).toFixed(1)}%` : "--"}
                    </td>
                  </tr>,
                  ...(isExpanded ? node.children.map(child => (
                    <tr key={`c-${child.id}`} className="border-t border-border bg-secondary/40">
                      <td className="px-4 py-2 pl-10 text-muted-foreground">{child.name}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{fmt(child.total)}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">
                        {grandTotal ? `${((child.total / grandTotal) * 100).toFixed(1)}%` : "--"}
                      </td>
                    </tr>
                  )) : []),
                ];
              })}
              <tr className="border-t border-border bg-secondary font-semibold">
                <td className="px-4 py-2">Total</td>
                <td className="px-4 py-2 text-right tabular-nums">{fmt(grandTotal)}</td>
                <td className="px-4 py-2 text-right text-muted-foreground">100%</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Spend Over Time ─────────────────────────────────────────────────────────

function SpendOverTime({ start, end, accounts, categories }: {
  start: string; end: string; accounts: Account[]; categories: Category[];
}) {
  const [data, setData] = useState<{ period: string; total_usd: number }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [accIds, setAccIds] = useState<Set<number>>(new Set());
  const [catIds, setCatIds] = useState<Set<number>>(new Set());

  const windowMonths = useMemo(() => reportMonths(start, end), [start, end]);
  const winStart = windowMonths[0];
  const winEnd = windowMonths[windowMonths.length - 1];

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    // Multi-select include: chosen ids are shown; none chosen = everything.
    const effAcc = accIds.size > 0 ? [...accIds] : [];
    const effCat = catIds.size > 0 ? [...catIds] : [];
    const params = qs({ start: winStart, end: winEnd, account_ids: effAcc.join(","), category_ids: effCat.join(",") });
    void fetchJson<unknown>(`/api/reports/spend-over-time${params}`, controller.signal)
      .then((d) => {
        if (!Array.isArray(d)) throw new Error("Invalid report response");
        setData(d);
      })
      .catch(() => { if (!controller.signal.aborted) setError("Couldn't load spending over time."); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [winStart, winEnd, accIds, catIds, accounts, categories]);

  const byPeriod = new Map(data.map(d => [d.period, Math.round(d.total_usd)]));
  const bars = windowMonths.map(ym => ({ period: ym, label: barLabel(ym), value: byPeriod.get(ym) ?? 0, current: ym === end }));
  const focusValue = byPeriod.get(end) ?? 0;
  const last3 = bars.slice(-Math.min(3, bars.length)).map(b => b.value);
  const avg = last3.length ? Math.round(last3.reduce((s, v) => s + v, 0) / last3.length) : 0;

  const accItems = accounts.map(a => ({ id: a.id, name: a.name }));
  const catItems = categories.map(c => ({ id: c.id, name: c.name, indent: c.parent_id !== null }));

  if (error) return <ReportLoadError message={error} />;

  return (
    <div className="space-y-5">
      {/* Headline: the selected month's spend */}
      <div>
        {loading ? (
          <Skeleton className="h-9 w-40" />
        ) : (
          <p className="text-3xl font-bold leading-tight tabular-nums">{USD.format(focusValue)}</p>
        )}
        <p className="text-sm text-muted-foreground">{monthLabel(end)}</p>
      </div>

      {loading ? (
        <div className="h-56 animate-pulse rounded-lg bg-secondary" />
      ) : (
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={bars} margin={{ top: 24, right: 0, left: 0, bottom: 0 }} barCategoryGap="16%">
            <XAxis dataKey="label" tick={{ fontSize: 12, fill: "var(--text-secondary)" }} axisLine={false} tickLine={false} interval={0} />
            {avg > 0 && bars.length > 1 && (
              <ReferenceLine y={avg} stroke="var(--text-tertiary)" strokeDasharray="4 2"
                label={{ value: `Average over ${last3.length} months ${USD.format(avg)}`, position: "insideTopLeft", fill: "var(--text-secondary)", fontSize: 12, dy: 6 }} />
            )}
            <Tooltip
              formatter={(v) => [USD.format(Number(v)), "Spend"]}
              contentStyle={TOOLTIP_STYLE}
              cursor={{ fill: "var(--border-subtle)" }}
            />
            <Bar dataKey="value" radius={0} maxBarSize={40} isAnimationActive={false}>
              {bars.map((b, i) => <Cell key={i} fill={b.current ? "var(--chart-selected)" : "var(--chart-bar)"} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      )}

      {/* Filters (secondary, below the chart) -- plain multi-select include pickers */}
      <div className="space-y-4 rounded-lg border border-border p-4">
        <IncludePicker title="Accounts" items={accItems} selected={accIds} onChange={setAccIds} />
        <IncludePicker title="Categories" items={catItems} selected={catIds} onChange={setCatIds} />
      </div>
    </div>
  );
}

// ─── Income vs Spend vs Savings ──────────────────────────────────────────────

interface ISSRow { period: string; income: number; spend: number; savings: number }

// A thin full-width comparison track for income and spending.
function CompareBar({ label, amount, fraction, color, rightAlign = false }: {
  label: string; amount: string; fraction: number; color: string; rightAlign?: boolean;
}) {
  const pct = Math.max(0, Math.min(100, fraction * 100));
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="text-sm">{label}</span>
        <span className="text-sm font-medium tabular-nums">{amount}</span>
      </div>
      <div className={cn("mt-2 flex h-1.5 w-full overflow-hidden rounded-full bg-secondary", rightAlign && "justify-end")}>
        <div className="h-full rounded-full" style={{ width: `${pct}%`, background: color }} />
      </div>
    </div>
  );
}

function LegendRow({ color, label, value, bar = false }: { color: string; label: string; value: string; bar?: boolean }) {
  return (
    <div className="flex items-center gap-2">
      {bar
        ? <span className="h-3 w-2.5 rounded-sm" style={{ background: color }} />
        : <span className="h-0.5 w-4 rounded" style={{ background: color }} />}
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium tabular-nums" style={{ color }}>{value}</span>
    </div>
  );
}

const NET_TEAL = "#3E8E86";

// The Net-income trend: Income/Spending lines on top, Net-income bars + EMA below,
// with ITS OWN period control (6m/1y/3y/All time), independent of the report period.
function NetIncomeTrend({ end, accountIds }: { end: string; accountIds: Set<number> }) {
  const [tp, setTp] = useState<"6m" | "1y" | "3y" | "all">("6m");
  const [data, setData] = useState<ISSRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const tStart = tp === "all" ? "2000-01" : shiftYm(end, tp === "6m" ? -5 : tp === "1y" ? -11 : -35);
  // Long ranges group per YEAR -- monthly points (36+) are unreadable.
  const groupBy = tp === "3y" || tp === "all" ? "year" : "month";

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void fetchJson<unknown>(`/api/reports/income-spend-savings${qs({ start: tStart, end, account_ids: [...accountIds].join(","), group_by: groupBy })}`, controller.signal)
      .then((d) => {
        if (!Array.isArray(d)) throw new Error("Invalid report response");
        setData(d);
      })
      .catch(() => { if (!controller.signal.aborted) setError("Couldn't load the net income trend."); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [tStart, end, groupBy, accountIds]);

  const rows = data.map(d => ({ label: formatPeriod(d.period), income: Math.round(d.income), spend: Math.round(d.spend), net: Math.round(d.income - d.spend) }));
  let emaAcc = 0;
  const chart = rows.map((r, i) => { emaAcc = i === 0 ? r.net : 0.5 * r.net + 0.5 * emaAcc; return { ...r, ema: Math.round(emaAcc) }; });
  const last = chart[chart.length - 1];
  const lastLabel = last?.label;
  const trend = last && chart.length >= 2 ? netIncomeTrend(chart[0].net, last.net) : null;
  const improving = trend?.direction === "up";
  const TrendIcon = improving ? TrendingUp : TrendingDown;

  return (
    <div className="space-y-4 border-t border-border pt-5">
      <h2 className="text-base font-semibold">Net income trend</h2>
      {error ? (
        <ReportLoadError message={error} />
      ) : loading ? (
        <div className="h-72 animate-pulse rounded-lg bg-secondary" />
      ) : chart.length < 2 || !last ? (
        <div className="rounded-lg border border-border p-8 text-center text-sm text-muted-foreground">Not enough data for a trend.</div>
      ) : (
        <>
          <div className="flex items-center gap-3 rounded-xl border border-border p-4">
            <span className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-full", improving ? "bg-surface-tint-income" : "bg-secondary")}>
              <TrendIcon className={cn("h-5 w-5", improving ? "text-income" : "text-negative")} />
            </span>
            <p className="text-sm">{trend?.message}</p>
          </div>

          {/* Top panel: Income + Spending lines */}
          <ResponsiveContainer width="100%" height={170}>
            <LineChart data={chart} margin={{ top: 24, right: 56, left: 0, bottom: 0 }}>
              <CartesianGrid horizontal={false} vertical stroke="var(--border-subtle)" />
              <XAxis dataKey="label" tick={{ fontSize: 12, fill: "var(--text-secondary)" }} axisLine={false} tickLine={false} interval="preserveStartEnd" />
              <YAxis hide domain={[0, "dataMax"]} />
              <ReferenceLine x={lastLabel} stroke="var(--text-tertiary)" strokeDasharray="3 3" />
              <Tooltip formatter={(v, n) => [USD.format(Number(v)), String(n)]} contentStyle={TOOLTIP_STYLE} />
              <Line dataKey="income" name="Income" stroke="var(--color-income)" strokeWidth={2.5} dot={false} isAnimationActive={false} />
              <Line dataKey="spend" name="Spending" stroke="var(--color-neutral-bar)" strokeWidth={2.5} dot={false} isAnimationActive={false} />
              <ReferenceDot x={lastLabel} y={last.income} r={4} fill="var(--color-income)" stroke="none" label={{ value: USD.format(last.income), position: "right", fill: "var(--color-income)", fontSize: 12, fontWeight: 600 }} />
              <ReferenceDot x={lastLabel} y={last.spend} r={4} fill="var(--color-neutral-bar)" stroke="none" label={{ value: USD.format(last.spend), position: "right", fill: "var(--text-primary)", fontSize: 12, fontWeight: 600 }} />
            </LineChart>
          </ResponsiveContainer>

          {/* Bottom panel: Net-income bars (teal/orange) + EMA line */}
          <ResponsiveContainer width="100%" height={140}>
            <ComposedChart data={chart} margin={{ top: 24, right: 56, left: 0, bottom: 0 }}>
              <XAxis dataKey="label" hide />
              <YAxis hide domain={["dataMin", "dataMax"]} />
              <ReferenceLine y={0} stroke="var(--border-subtle)" />
              <ReferenceLine x={lastLabel} stroke="var(--text-tertiary)" strokeDasharray="3 3" />
              <Tooltip formatter={(v, n) => [USD.format(Number(v)), String(n)]} contentStyle={TOOLTIP_STYLE} />
              <Bar dataKey="net" name="Net income" maxBarSize={26} isAnimationActive={false}>
                {chart.map((d, i) => <Cell key={i} fill={d.net >= 0 ? NET_TEAL : "var(--color-negative)"} />)}
              </Bar>
              <Line dataKey="ema" name="Trend (EMA)" stroke="var(--color-confirm)" strokeWidth={2} dot={false} isAnimationActive={false} />
              <ReferenceDot x={lastLabel} y={last.net} r={4} fill={last.net >= 0 ? NET_TEAL : "var(--color-negative)"} stroke="none" label={{ value: USD.format(last.net), position: "top", fill: last.net >= 0 ? NET_TEAL : "var(--color-negative)", fontSize: 12, fontWeight: 600 }} />
            </ComposedChart>
          </ResponsiveContainer>

          {/* The trend's own period control */}
          <div className="flex gap-1 text-sm">
            {(["6m", "1y", "3y", "all"] as const).map(v => (
              <button key={v} onClick={() => setTp(v)}
                className={cn("rounded-full px-3 py-1 transition-colors", tp === v ? "bg-secondary font-medium text-foreground" : "text-muted-foreground hover:text-foreground")}>
                {v === "all" ? "All time" : v}
              </button>
            ))}
          </div>

          {/* Legend (4 series) */}
          <div className="space-y-1.5 text-sm">
            <LegendRow color="var(--color-income)" label="Income" value={USD.format(last.income)} />
            <LegendRow color="var(--color-neutral-bar)" label="Spending" value={USD.format(last.spend)} />
            <LegendRow color="var(--color-confirm)" label="Trend (EMA)" value={USD.format(last.ema)} />
            <LegendRow color={NET_TEAL} label="Net income" value={USD.format(last.net)} bar />
          </div>
        </>
      )}
    </div>
  );
}

function IncomeSpendSavings({ start, end, accountIds, rangeLabel }: {
  start: string; end: string; accountIds: Set<number>; rangeLabel: string;
}) {
  const [data, setData] = useState<ISSRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void fetchJson<unknown>(`/api/reports/income-spend-savings${qs({ start, end, account_ids: [...accountIds].join(",") })}`, controller.signal)
      .then((d) => {
        if (!Array.isArray(d)) throw new Error("Invalid report response");
        setData(d);
      })
      .catch(() => { if (!controller.signal.aborted) setError("Couldn't load income and spending."); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [start, end, accountIds]);

  const totals = data.reduce((a, d) => ({ income: a.income + d.income, spend: a.spend + d.spend }), { income: 0, spend: 0 });
  const net = totals.income - totals.spend;
  const sharePct = totals.income > 0 ? Math.round((totals.spend / totals.income) * 100) : 0;
  const cmpMax = Math.max(totals.income, totals.spend, Math.abs(net), 1);

  if (error) return <ReportLoadError message={error} />;

  return (
    <div className="space-y-6">
      {/* Share of spending + comparison bars (report period) */}
      {!loading && (
        <div className="space-y-4">
          <div>
            <p className="text-sm text-muted-foreground">Share of spending</p>
            <p className="text-3xl font-bold leading-tight tabular-nums">{totals.income > 0 ? `${sharePct}%` : "--"}</p>
            <p className="text-sm text-muted-foreground">{rangeLabel}</p>
          </div>
          <div className="space-y-3">
            <CompareBar label="Income" amount={USD.format(totals.income)} fraction={totals.income / cmpMax} color="var(--color-income)" />
            <CompareBar label="Spending" amount={USD.format(totals.spend)} fraction={totals.spend / cmpMax} color="var(--color-neutral-bar)" />
            <CompareBar label="Net income" amount={`${net < 0 ? "−" : ""}${USD.format(Math.abs(net))}`} fraction={Math.abs(net) / cmpMax} color={net < 0 ? "var(--color-negative)" : "var(--color-income)"} rightAlign />
          </div>
        </div>
      )}

      <NetIncomeTrend end={end} accountIds={accountIds} />
    </div>
  );
}

// ─── Period comparison ───────────────────────────────────────────────────────

interface DaySpend { date: string; total_usd: number }

// Cumulative running spend, indexed by day-offset from the period start.
function cumulativeByDay(rows: DaySpend[], startDate: string): number[] {
  const start0 = new Date(startDate).getTime();
  const byDay = new Map<number, number>();
  for (const r of rows) {
    const day = Math.round((new Date(r.date).getTime() - start0) / 86400000);
    if (day >= 0) byDay.set(day, (byDay.get(day) ?? 0) + r.total_usd);
  }
  const maxDay = byDay.size ? Math.max(...byDay.keys()) : -1;
  const out: number[] = [];
  let acc = 0;
  for (let i = 0; i <= maxDay; i++) { acc += byDay.get(i) ?? 0; out.push(acc); }
  return out;
}

function PeriodComparison({ start, end, accountIds, categories }: {
  start: string; end: string; accountIds: Set<number>; categories: Category[];
}) {
  const [curr, setCurr] = useState<DaySpend[]>([]);
  const [prev, setPrev] = useState<DaySpend[]>([]);
  const [currCats, setCurrCats] = useState<SpendRow[]>([]);
  const [prevCats, setPrevCats] = useState<SpendRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const span = monthSpan(start, end);
  const prevEnd = shiftYm(start, -1);
  const prevStart = shiftYm(prevEnd, -(span - 1));
  const currStartDate = firstDay(start), currEndDate = lastDay(end);
  const prevStartDate = firstDay(prevStart), prevEndDate = lastDay(prevEnd);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    const acc = [...accountIds].join(",");
    Promise.all([
      fetchJson<unknown>(`/api/reports/spend-by-day${qs({ start: currStartDate, end: currEndDate, account_ids: acc })}`, controller.signal),
      fetchJson<unknown>(`/api/reports/spend-by-day${qs({ start: prevStartDate, end: prevEndDate, account_ids: acc })}`, controller.signal),
      fetchJson<unknown>(`/api/reports/spend-by-category${qs({ start, end, account_ids: acc })}`, controller.signal),
      fetchJson<unknown>(`/api/reports/spend-by-category${qs({ start: prevStart, end: prevEnd, account_ids: acc })}`, controller.signal),
    ]).then(([c, p, cc, pc]) => {
      if (![c, p, cc, pc].every(Array.isArray)) throw new Error("Invalid report response");
      setCurr(Array.isArray(c) ? c : []); setPrev(Array.isArray(p) ? p : []);
      setCurrCats(Array.isArray(cc) ? cc : []); setPrevCats(Array.isArray(pc) ? pc : []);
    }).catch(() => {
      if (!controller.signal.aborted) setError("Couldn't load the period comparison.");
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [currStartDate, currEndDate, prevStartDate, prevEndDate, start, end, prevStart, prevEnd, accountIds]);

  const currCum = cumulativeByDay(curr, currStartDate);
  const prevCum = cumulativeByDay(prev, prevStartDate);
  const maxLen = Math.max(currCum.length, prevCum.length);
  const chartData = Array.from({ length: maxLen }, (_, i) => ({
    day: i + 1,
    current: i < currCum.length ? currCum[i] : null,
    comparison: i < prevCum.length ? prevCum[i] : null,
  }));
  const currTotal = currCum.length ? currCum[currCum.length - 1] : 0;
  const prevTotal = prevCum.length ? prevCum[prevCum.length - 1] : 0;
  const diff = currTotal - prevTotal;
  const diffPct = prevTotal > 0 ? Math.round((diff / prevTotal) * 1000) / 10 : 0;
  const higher = diff > 0;

  // Per-category change vs the previous period, split into Decreased / Increased /
  // Not changed. Union both periods' categories so a category that dropped to $0
  // still shows up as a decrease.
  const currTree = buildCategoryTree(currCats, categories);
  const prevTree = buildCategoryTree(prevCats, categories);
  const currById = new Map(currTree.map(n => [n.id, n]));
  const prevTotalById = new Map(prevTree.map(n => [n.id, n.total]));
  const allCatIds = Array.from(new Set<number | null>([...currById.keys(), ...prevTotalById.keys()]));
  const CHANGE_EPS = 0.005;
  const changes = allCatIds.map((id, i) => {
    const node = currById.get(id);
    const cur = node?.total ?? 0;
    const prev = prevTotalById.get(id) ?? 0;
    const delta = cur - prev;
    const pct = prev > 0 ? Math.round((delta / prev) * 100) : (cur > 0 ? 100 : 0);
    const name = node?.name ?? prevTree.find(n => n.id === id)?.name ?? "Uncategorized";
    return { id, name, color: categoryColor(i), cur, delta, pct };
  });
  const decreased = changes.filter(c => c.delta < -CHANGE_EPS).sort((a, b) => a.delta - b.delta);
  const increased = changes.filter(c => c.delta > CHANGE_EPS).sort((a, b) => b.delta - a.delta);
  const notChanged = changes.filter(c => Math.abs(c.delta) <= CHANGE_EPS && c.cur > 0);
  const anyChange = decreased.length + increased.length + notChanged.length > 0;

  type Change = (typeof changes)[number];
  const renderGroup = (title: string, items: Change[], dir: "up" | "down" | "flat") => {
    if (items.length === 0) return null;
    return (
      <div className="space-y-1">
        <p className="text-sm text-muted-foreground">{title}</p>
        <div className="divide-y divide-border">
          {items.map(({ id, name, color, cur, delta, pct }) => (
            <div key={String(id)} className="flex items-center gap-3 py-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-secondary">
                <span className="h-3 w-3 rounded-full" style={{ background: color }} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{name}</div>
                <div className="text-xs tabular-nums text-muted-foreground">{USD.format(cur)}</div>
              </div>
              <div className="text-right">
                <div className={cn("text-sm font-semibold tabular-nums",
                  dir === "up" ? "text-negative" : dir === "down" ? "text-income" : "text-muted-foreground")}>
                  {dir === "flat" ? USD.format(0) : `${delta > 0 ? "+" : "−"}${USD.format(Math.abs(delta))}`}
                </div>
                <div className="text-xs tabular-nums text-muted-foreground">
                  {dir === "flat" ? "0%" : `${delta > 0 ? "↑" : "↓"}${Math.abs(pct)}%`}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  };

  if (error) return <ReportLoadError message={error} />;

  return (
    <div className="space-y-5">
      {/* Two period totals */}
      <div className="flex flex-wrap gap-x-10 gap-y-2">
        <div>
          <div className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-full bg-foreground" />
            <span className="text-sm text-muted-foreground">{rangeLabel(start, end)}</span>
          </div>
          {loading
            ? <Skeleton className="h-7 w-28" />
            : <p className="text-2xl font-bold tabular-nums">{USD.format(currTotal)}</p>}
        </div>
        <div>
          <div className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-full" style={{ background: "var(--text-tertiary)" }} />
            <span className="text-sm text-muted-foreground">{rangeLabel(prevStart, prevEnd)}</span>
          </div>
          {loading
            ? <Skeleton className="h-7 w-28" />
            : <p className="text-2xl font-bold tabular-nums text-muted-foreground">{USD.format(prevTotal)}</p>}
        </div>
      </div>

      {loading ? (
        <div className="h-60 animate-pulse rounded-lg bg-secondary" />
      ) : maxLen < 2 ? (
        <div className="rounded-lg border border-border p-8 text-center text-sm text-muted-foreground">Not enough data to compare.</div>
      ) : (
        <>
          <ResponsiveContainer width="100%" height={240}>
            <LineChart data={chartData} margin={{ top: 20, right: 56, left: 0, bottom: 0 }}>
              <XAxis dataKey="day" hide />
              <YAxis hide domain={[0, "dataMax"]} />
              <ReferenceLine x={currCum.length} stroke="var(--text-tertiary)" strokeDasharray="3 3" />
              <Tooltip formatter={(v, n) => [USD.format(Number(v)), String(n)]} labelFormatter={(d) => `Day ${d}`} contentStyle={TOOLTIP_STYLE} />
              <Line dataKey="comparison" name="Previous" stroke="var(--text-tertiary)" strokeWidth={2} dot={false} connectNulls isAnimationActive={false} />
              <Line dataKey="current" name="Current" stroke="var(--color-foreground)" strokeWidth={2.5} dot={false} connectNulls isAnimationActive={false} />
              <ReferenceDot x={currCum.length} y={currTotal} r={4} fill="var(--text-primary)" stroke="none"
                label={{ value: USD.format(currTotal), position: "right", fill: "var(--text-primary)", fontSize: 12, fontWeight: 600 }} />
            </LineChart>
          </ResponsiveContainer>

          {/* Insight card */}
          <div className="flex items-center gap-3 rounded-xl border border-border p-4">
            <span className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-full", higher ? "bg-secondary" : "bg-surface-tint-income")}>
              <TrendingUp className={cn("h-5 w-5", higher ? "text-negative" : "text-income", !higher && "-scale-y-100")} />
            </span>
            <p className="text-sm">
              {prevTotal > 0
                ? `Total spend this period is ${higher ? "higher" : "lower"} by ${USD.format(Math.abs(diff))} (${Math.abs(diffPct)}%).`
                : "No spending in the previous period to compare against."}
            </p>
          </div>

          {/* Spending by category -- Decreased / Increased / Not changed */}
          {anyChange && (
            <div className="space-y-4 border-t border-border pt-4">
              <h3 className="text-base font-semibold">Spending by category</h3>
              {renderGroup("Decreased ↓", decreased, "down")}
              {renderGroup("Increased ↑", increased, "up")}
              {renderGroup("Not changed", notChanged, "flat")}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ─── Reports page ─────────────────────────────────────────────────────────────

// Remember the last-opened report + period across sessions so returning users
// land where they left off (validated against the current options on load).
const REPORTS_VIEW_KEY = "balance-reports-view";
const REPORTS_PERIOD_KEY = "balance-reports-period";

function loadReportsView(): ReportId {
  try {
    const v = localStorage.getItem(REPORTS_VIEW_KEY);
    if (v && REPORTS.some((r) => r.id === v)) return v as ReportId;
  } catch { /* storage unavailable */ }
  return "spend-by-category";
}

function loadReportsPeriod(view: ReportId): Period {
  try {
    const p = localStorage.getItem(REPORTS_PERIOD_KEY);
    if (p && PERIOD_OPTIONS[view].includes(p as Period)) return p as Period;
  } catch { /* storage unavailable */ }
  return "this-month";
}

export default function Reports() {
  const t = useT();
  const [accounts, setAccounts]     = useState<Account[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [view, setView] = useState<ReportId>(loadReportsView);
  const [accountIds, setAccountIds] = useState<Set<number>>(new Set());
  const [period, setPeriod] = useState<Period>(() => loadReportsPeriod(view));
  const initial = period === "custom" ? periodToRange("this-month") : periodToRange(period);
  const [start, setStart] = useState(initial.start);
  const [end,   setEnd]   = useState(initial.end);
  const [filterOpen, setFilterOpen] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  function handlePeriodChange(p: Exclude<Period, "custom">) {
    setPeriod(p);
    const r = periodToRange(p);
    setStart(r.start);
    setEnd(r.end);
  }

  function openReport(id: ReportId) {
    if (!PERIOD_OPTIONS[id].includes(period)) handlePeriodChange("this-month");
    setView(id);
  }

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      fetchJson<unknown>("/api/accounts", controller.signal),
      fetchJson<unknown>("/api/categories", controller.signal),
    ]).then(([accountRows, categoryRows]) => {
      if (!Array.isArray(accountRows) || !Array.isArray(categoryRows)) throw new Error("Invalid filter response");
      setAccounts(accountRows);
      setCategories(categoryRows);
      setLoadError(null);
    }).catch(() => {
      if (!controller.signal.aborted) setLoadError("Couldn't load report filters.");
    });
    markReportViewed(); // completes step 3 of the first-run checklist
    return () => controller.abort();
  }, []);

  useEffect(() => { try { localStorage.setItem(REPORTS_VIEW_KEY, view); } catch { /* ignore */ } }, [view]);
  useEffect(() => { try { localStorage.setItem(REPORTS_PERIOD_KEY, period); } catch { /* ignore */ } }, [period]);

  const label = rangeLabel(start, end);

  // Two-pane on desktop: a persistent report-type list (left rail) and the
  // selected report's detail (right). On mobile it drills in -- the list is the
  // landing page, and opening a report replaces it (back arrow returns).
  const current = REPORTS.find(r => r.id === view)!;
  const usesAccountFilter = view !== "spend-over-time" && view !== "subscriptions"; // SOT has its own filters; subscriptions has none

  return (
    <PageContainer className="py-4 lg:py-6">
      <div className="lg:grid lg:grid-cols-[210px_minmax(0,1fr)] lg:gap-8">
      {/* Report switcher: a horizontal strip on mobile, a persistent left rail on desktop. */}
      <nav aria-label="Reports" className="-mx-4 mb-4 flex items-center gap-1 overflow-x-auto border-b border-border px-4 sm:mx-0 sm:px-0 lg:mx-0 lg:mb-0 lg:flex-col lg:items-stretch lg:gap-0.5 lg:overflow-visible lg:border-b-0 lg:border-r lg:px-0 lg:pr-4">
        {REPORTS.map(({ id, icon: Icon }) => {
          const active = id === view;
          return (
            <button
              key={id}
              onClick={() => openReport(id)}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex shrink-0 items-center gap-2 border-b-2 px-3 py-2.5 text-sm transition-colors lg:w-full lg:rounded-md lg:border-b-0 lg:border-l-2 lg:py-2",
                active
                  ? "border-primary font-medium text-primary lg:bg-secondary/60"
                  : "border-transparent text-muted-foreground hover:text-foreground lg:hover:bg-secondary/40",
              )}
            >
              <Icon className="h-4 w-4 shrink-0" />
              {t(`reports.${id}`)}
            </button>
          );
        })}
      </nav>

      {/* Selected report */}
      <div className="min-w-0 space-y-4">
        {loadError && <ReportLoadError message={loadError} />}
        <div className="flex items-center gap-2">
          <h1 className="flex-1 truncate text-lg font-semibold tracking-tight">{t(`reports.${current.id}`)}</h1>
          {usesAccountFilter && (
            <button onClick={() => setFilterOpen(true)} aria-label="Filter"
              className="relative flex h-9 w-9 items-center justify-center rounded-lg hover:bg-secondary">
              <Filter className="h-5 w-5" />
              {accountIds.size > 0 && (
                <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground">
                  {accountIds.size}
                </span>
              )}
            </button>
          )}
        </div>

        {/* Period chips (set varies per report). The -mx-4 lets the row bleed to
            the screen edge on mobile; reset it from sm up so it never overflows
            the content column (was causing a horizontal scrollbar on desktop). */}
        {PERIOD_OPTIONS[view].length > 0 && (
        <div className="-mx-4 flex items-center gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-0">
          {PERIOD_OPTIONS[view].map(p => (
            <button key={p}
              onClick={() => (p === "custom" ? setPeriod("custom") : handlePeriodChange(p as Exclude<Period, "custom">))}
              className={cn("shrink-0 rounded-full border px-3 py-1.5 text-sm transition-colors",
                period === p ? "border-primary bg-primary text-primary-foreground" : "border-border text-muted-foreground hover:text-foreground")}>
              {t(`period.${p}`)}
            </button>
          ))}
          {period === "custom" && (
            <MonthYearPicker value={start} onChange={v => { setStart(v); setEnd(v); }} />
          )}
        </div>
        )}

        {/* Report content */}
        {view === "spend-by-category" && <SpendByCategory start={start} end={end} accountIds={accountIds} rangeLabel={label} categories={categories} />}
        {view === "spend-over-time" && <SpendOverTime start={start} end={end} accounts={accounts} categories={categories} />}
        {view === "income-spend-savings" && <IncomeSpendSavings start={start} end={end} accountIds={accountIds} rangeLabel={label} />}
        {view === "period-comparison" && <PeriodComparison start={start} end={end} accountIds={accountIds} categories={categories} />}
        {view === "subscriptions" && <SubscriptionsReport />}
        </div>
      </div>

      {/* Account filter sheet */}
      <Sheet open={filterOpen} onOpenChange={setFilterOpen}>
        <SheetContent side="bottom" className="p-4">
          <SheetHeader className="mb-3 text-left">
            <SheetTitle>Filter by account</SheetTitle>
          </SheetHeader>
          <AccountFilter accounts={accounts} selected={accountIds} onChange={setAccountIds} />
          <Button className="mt-4 w-full" onClick={() => setFilterOpen(false)}>Apply</Button>
        </SheetContent>
      </Sheet>
    </PageContainer>
  );
}
