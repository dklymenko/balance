import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { parsePendingAmazonText } from "@/lib/amazonPending";
import { getDesktopBridge, scrapeWindowFor } from "@/lib/desktopBridge";
import type { InitialBulkRow } from "@/components/MultiTransactionForm";

interface MatchResult {
  _id: string | null;
  index: number;
  summary: string;
  items: string[];
}

interface PreviewRow {
  id: string;
  date: string;
  amount: number;
  matched: boolean;
  summary: string;
  items: string[];
}

const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

function fmtDate(iso: string): string {
  return new Date(iso + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

interface Props {
  open: boolean;
  onClose: () => void;
  // Hand the selected charges to the entry form (pre-filled) so the user can review and save.
  onImport: (rows: InitialBulkRow[]) => void;
}

export default function PendingAmazonDialog({ open, onClose, onImport }: Props) {
  const [text, setText] = useState("");
  const [matching, setMatching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<PreviewRow[] | null>(null);
  const [stats, setStats] = useState<{ matched: number; total: number; scraped: number } | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [defaultAccountId, setDefaultAccountId] = useState<number | null>(null);

  function toggle(id: string) {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function toggleSelected(id: string) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function handleMatch() {
    setMatching(true);
    setError(null);
    setResults(null);
    setStats(null);
    try {
      const charges = parsePendingAmazonText(text);
      if (charges.length === 0) {
        setError("No charges found. Paste the pending transactions from your bank, including dates and $ amounts.");
        return;
      }
      // Inside the Balance Desktop shell the scrape runs locally in the
      // shell's Amazon window and the orders travel in the request body. A
      // plain browser has no access to that desktop-only capability.
      const bridge = getDesktopBridge();
      const rows = charges.map(c => ({
        _id: crypto.randomUUID(),
        date: c.date,
        amount: c.amount.toFixed(2),
        description: "Amazon",
        type: "debit" as const,
      }));
      const orders = bridge
        ? await bridge.scrapeAmazon(scrapeWindowFor(charges.map(c => c.date))!)
        : undefined;
      const res = await fetch("/api/imports/amazon-match", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(orders ? { rows, orders } : { rows }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: string; detail?: string };
        setError(`Error: ${err.error ?? res.statusText}${err.detail ? ` -- ${err.detail}` : ""}`);
        return;
      }
      const json = await res.json() as {
        matches: MatchResult[];
        matched_count: number;
        scraped_orders: number;
        default_account_id: number | null;
      };
      const byId = new Map(json.matches.filter(m => m._id).map(m => [m._id as string, m]));
      const preview: PreviewRow[] = rows.map(r => {
        const m = byId.get(r._id);
        return {
          id: r._id,
          date: r.date,
          amount: Number(r.amount),
          matched: !!m,
          summary: m?.summary ?? "",
          items: m?.items ?? [],
        };
      });
      setResults(preview);
      setSelected(new Set(preview.map(r => r.id))); // default: keep all (they'll post anyway)
      setDefaultAccountId(json.default_account_id);
      setStats({ matched: json.matched_count, total: charges.length, scraped: json.scraped_orders });
    } catch (e) {
      setError(`Error: ${(e as Error).message}`);
    } finally {
      setMatching(false);
    }
  }

  function handleImport() {
    if (!results) return;
    const rows: InitialBulkRow[] = results
      .filter(r => selected.has(r.id))
      .map(r => ({
        date: r.date,
        amount: r.amount.toFixed(2),
        description: r.summary || "Amazon",
        type: "debit" as const,
        account_id: defaultAccountId != null ? String(defaultAccountId) : undefined,
      }));
    onImport(rows);
    reset();
  }

  function reset() {
    setText("");
    setResults(null);
    setStats(null);
    setError(null);
    setExpanded(new Set());
    setSelected(new Set());
    setDefaultAccountId(null);
  }

  function handleClose() {
    reset();
    onClose();
  }

  const selectedCount = selected.size;

  return (
    <Dialog open={open} onOpenChange={v => !v && handleClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Match pending Amazon charges</DialogTitle>
        </DialogHeader>

        <p className="text-sm text-muted-foreground">
          Paste pending Amazon charges from your bank. Balance opens your order history in a private
          desktop window, matches each charge to likely items, and lets you review transactions before
          adding them.
        </p>

        <textarea
          value={text}
          onChange={e => setText(e.target.value)}
          placeholder={"Jan 5, 2026\nAmazon.com\n$12.34\n…"}
          aria-label="Pending Amazon charges"
          className="w-full h-40 rounded-md border bg-background px-3 py-2 text-sm font-mono resize-y"
        />

        {error && <p className="text-sm text-red-600">{error}</p>}
        {stats && (
          <p className="text-sm text-muted-foreground">
            {stats.matched} of {stats.total} charge{stats.total !== 1 ? "s" : ""} matched · compared with {stats.scraped} orders
          </p>
        )}

        {results && results.length > 0 && (
          <div className="max-h-[40vh] overflow-auto rounded-md border divide-y">
            {results.map(r => (
              <div key={r.id} className="px-3 py-2 text-sm">
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={selected.has(r.id)}
                    onChange={() => toggleSelected(r.id)}
                    className="h-4 w-4 shrink-0 rounded border"
                    aria-label={`Include ${USD.format(r.amount)} charge from ${fmtDate(r.date)}`}
                  />
                  <span className="tabular-nums text-muted-foreground w-14 shrink-0">{fmtDate(r.date)}</span>
                  <span className="tabular-nums font-medium w-20 shrink-0">{USD.format(r.amount)}</span>
                  {r.matched ? (
                    r.items.length > 0 ? (
                      <button type="button" onClick={() => toggle(r.id)}
                        className="flex items-center gap-1 text-left min-w-0 hover:text-foreground">
                        {expanded.has(r.id)
                          ? <ChevronDown className="w-4 h-4 shrink-0" />
                          : <ChevronRight className="w-4 h-4 shrink-0" />}
                        <span className="truncate">{r.summary}</span>
                      </button>
                    ) : (
                      <span className="text-muted-foreground">matched (no item details)</span>
                    )
                  ) : (
                    <span className="text-muted-foreground italic">no Amazon order found</span>
                  )}
                </div>
                {r.matched && expanded.has(r.id) && r.items.length > 0 && (
                  <ul className="mt-1 ml-[9rem] text-xs text-muted-foreground list-disc pl-4 leading-tight space-y-0.5">
                    {r.items.map((it, i) => <li key={i}>{it}</li>)}
                  </ul>
                )}
              </div>
            ))}
          </div>
        )}

        <DialogFooter className="sm:justify-between">
          <Button variant="outline" onClick={handleClose}>Close</Button>
          <div className="flex gap-2">
            <Button onClick={handleMatch} disabled={matching || !text.trim()} variant={results ? "outline" : "default"}>
              {matching ? "Matching…" : results ? "Re-match" : "Match"}
            </Button>
            {results && results.length > 0 && (
              <Button onClick={handleImport} disabled={selectedCount === 0}>
                Add {selectedCount} to entry form
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
