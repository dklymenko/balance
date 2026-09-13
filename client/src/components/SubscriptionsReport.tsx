import { useEffect, useState } from "react";
import { Repeat } from "lucide-react";

interface Subscription {
  merchant: string;
  description: string;
  category_name: string | null;
  monthly_usd: number;
  last_charge: string;
  charges: number;
}

const USD = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
});

// Recurring charges detected from the household's own ledger (monthly cadence,
// stable amount). Read-only insight -- the retention answer to "what am I
// actually paying for every month?". Rendered as a report view inside the
// Reports page (rail entry "subscriptions").
export default function SubscriptionsReport() {
  const [subs, setSubs] = useState<Subscription[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/insights/subscriptions", { signal: controller.signal })
      .then((r) => {
        if (!r.ok) throw new Error(`Request failed (${r.status})`);
        return r.json();
      })
      .then((d: { subscriptions?: Subscription[]; total_monthly_usd?: number }) => {
        setSubs(Array.isArray(d.subscriptions) ? d.subscriptions : []);
        setTotal(typeof d.total_monthly_usd === "number" ? d.total_monthly_usd : 0);
        setError(null);
      })
      .catch(() => { if (!controller.signal.aborted) setError("Couldn't load recurring charges. Please try again."); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, []);

  return (
    <div className="max-w-2xl space-y-6">
      <p className="text-sm text-muted-foreground">
        Recurring charges detected in your ledger: monthly cadence, stable amount.
      </p>

      {error ? (
        <p role="alert" className="rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
          {error}
        </p>
      ) : loading ? (
        <p className="text-sm text-muted-foreground">Looking for recurring charges…</p>
      ) : subs.length === 0 ? (
        <div className="rounded-lg border py-10 px-6 text-center text-sm text-muted-foreground">
          No subscriptions detected yet. Detection needs about three months of
          transactions for a merchant, so keep the ledger current and check back.
        </div>
      ) : (
        <>
          <div className="rounded-lg border p-4">
            <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
              {subs.length} recurring charge{subs.length !== 1 ? "s" : ""}
            </p>
            <p className="mt-1 text-3xl font-bold tabular-nums">
              {USD.format(total)}<span className="text-base font-medium text-muted-foreground"> / month</span>
            </p>
          </div>

          <ul className="rounded-lg border divide-y">
            {subs.map((s) => (
              <li key={s.merchant} className="flex items-center gap-3 px-4 py-3">
                <Repeat className="h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{s.description}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {[s.category_name, `${s.charges} charges`, `last on ${s.last_charge}`]
                      .filter(Boolean).join(" · ")}
                  </p>
                </div>
                <p className="shrink-0 text-sm font-semibold tabular-nums">
                  {USD.format(s.monthly_usd)}<span className="text-xs font-normal text-muted-foreground">/mo</span>
                </p>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
