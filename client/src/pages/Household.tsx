import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronRight } from "lucide-react";
import { apiFetch, getMe, type Me } from "@/lib/api";
import ThemeToggle from "@/components/ThemeToggle";
import FontSizeToggle from "@/components/FontSizeToggle";
import AppLockSection from "@/components/AppLockSection";
import EncryptionSection from "@/components/EncryptionSection";
import PageContainer from "@/components/PageContainer";
import { useAdvancedFeatures, setAdvancedFeatures } from "@/lib/features";
import { CURRENCIES } from "@/lib/currencies";
import { useT, useLang, setLang, LANGS, type Lang } from "@/lib/i18n";

// Local preferences and data controls. Base currency persists via
// PATCH /api/settings; visual and language preferences stay in this profile.
export default function Household() {
  const t = useT();
  const lang = useLang();
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resetOpen, setResetOpen] = useState(false);
  const [resetConfirm, setResetConfirm] = useState("");
  const [resetMsg, setResetMsg] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);
  const [importingArchive, setImportingArchive] = useState(false);
  const [archiveMsg, setArchiveMsg] = useState<string | null>(null);
  const archiveInputRef = useRef<HTMLInputElement>(null);
  const advanced = useAdvancedFeatures();
  const [baseCurrency, setBaseCurrency] = useState("USD");

  async function load() {
    try {
      const m = await getMe();
      setMe(m);
      setBaseCurrency(m?.household?.base_currency ?? "USD");
    } catch {
      setError("Couldn't load settings. Please try again.");
    }
  }

  useEffect(() => { void load(); }, []);

  async function saveCurrency(c: string) {
    const previous = baseCurrency;
    setError(null);
    setBaseCurrency(c);
    try {
      const response = await apiFetch("/api/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ base_currency: c }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({} as { error?: string }));
        throw new Error(body.error ?? "Couldn't save the base currency.");
      }
    } catch (cause) {
      setBaseCurrency(previous);
      setError(cause instanceof Error ? cause.message : "Couldn't save the base currency.");
    }
  }

  const householdNameActual = me?.household.name ?? "";

  async function resetData() {
    setError(null);
    setResetting(true);
    try {
      const res = await apiFetch("/api/data/reset", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: resetConfirm }),
      });
      if (res.ok) {
        setResetMsg("All financial data deleted.");
        setResetOpen(false);
        setResetConfirm("");
        load();
      } else {
        const d = await res.json().catch(() => ({}));
        setError(d.error ?? "Reset failed.");
      }
    } catch {
      setError("Reset failed. Please try again.");
    } finally {
      setResetting(false);
    }
  }

  async function importArchive(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setError(null);
    setArchiveMsg(null);
    setImportingArchive(true);
    try {
      if (file.size > 10_000_000) throw new Error("That backup is larger than the 10 MB import limit.");
      let archive: unknown;
      try { archive = JSON.parse(await file.text()); }
      catch { throw new Error("That file is not valid JSON."); }
      const response = await apiFetch("/api/data/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(archive),
      });
      const body = await response.json().catch(() => ({} as { error?: string; imported?: number }));
      if (!response.ok) throw new Error(body.error ?? "Import failed.");
      setArchiveMsg(`Backup restored successfully (${body.imported ?? 0} records).`);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Import failed.");
    } finally {
      setImportingArchive(false);
    }
  }

  return (
    <PageContainer className="max-w-2xl py-6 space-y-8">
      <h1 className="text-xl font-bold tracking-tight">{t("nav.settings")}</h1>
      {error && (
        <p role="alert" className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
          {error}
        </p>
      )}

      <section className="space-y-2">
        <h2 className="text-sm font-medium">{t("settings.manage")}</h2>
        <Link to="/categories"
          className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-sm hover:bg-secondary">
          <span>{t("settings.categories")}</span>
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
        </Link>
      </section>

      {(
        <section className="space-y-2">
          <h2 className="text-sm font-medium"><label htmlFor="base-currency">{t("settings.baseCurrency")}</label></h2>
          <p className="text-xs text-muted-foreground">
            {t("settings.baseCurrencyHint")}
          </p>
          <select
            id="base-currency"
            value={baseCurrency}
            onChange={(e) => saveCurrency(e.target.value)}
            className="rounded-md border bg-background px-3 py-1.5 text-sm"
          >
            {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </section>
      )}

      <section className="space-y-2">
        <h2 className="text-sm font-medium"><label htmlFor="language">{t("settings.language")}</label></h2>
        <p className="text-xs text-muted-foreground">{t("settings.languageHint")}</p>
        <select
          id="language"
          value={lang}
          onChange={(e) => setLang(e.target.value as Lang)}
          className="rounded-md border bg-background px-3 py-1.5 text-sm"
        >
          {LANGS.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
        </select>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-medium">{t("settings.appearance")}</h2>
        <p className="text-xs text-muted-foreground">{t("settings.appearanceHint")}</p>
        <ThemeToggle />
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-medium">{t("settings.textSize")}</h2>
        <p className="text-xs text-muted-foreground">{t("settings.textSizeHint")}</p>
        <FontSizeToggle />
      </section>

      <AppLockSection />

      <EncryptionSection />

      <section className="space-y-2">
        <h2 className="text-sm font-medium">{t("settings.experimental")}</h2>
        <p className="text-xs text-muted-foreground">
          Show power-user tools that are hidden by default: the recently-added filter,
          exclude-from-reports, and existing-ledger imports.
        </p>
        <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
          <input
            type="checkbox"
            checked={advanced}
            onChange={(e) => setAdvancedFeatures(e.target.checked)}
            className="h-4 w-4 rounded border"
          />
          Enable experimental features
        </label>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-medium">Data</h2>
        <p className="text-xs text-muted-foreground">
          Download a complete ledger backup, or restore one into an empty Balance ledger.
        </p>
        <div className="flex flex-wrap gap-2">
          <a href="/api/data/export" download
            className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted">Download JSON backup</a>
          <a href="/api/data/export/transactions.csv" download
            className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted">Download transactions CSV</a>
          <button type="button" onClick={() => archiveInputRef.current?.click()} disabled={importingArchive}
            className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50">
            {importingArchive ? "Restoring…" : "Restore JSON backup"}
          </button>
          <input ref={archiveInputRef} type="file" accept="application/json,.json" className="sr-only"
            aria-label="Choose JSON backup" onChange={importArchive} />
        </div>
        <p className="text-xs text-muted-foreground">Restore is all-or-nothing and is available only when the ledger is empty.</p>
        {archiveMsg && <p role="status" className="text-xs text-green-600">{archiveMsg}</p>}
      </section>

      {(
        <section className="space-y-2 rounded-md border border-red-300 p-4">
          <h2 className="text-sm font-medium text-red-700">Danger zone</h2>
          <p className="text-xs text-muted-foreground">
            Permanently delete all accounts, transactions, categories, tags, and
            adjustments. This cannot be undone -- download a backup first.
          </p>
          {resetMsg && <p className="text-xs text-green-600">{resetMsg}</p>}
          {!resetOpen ? (
            <button onClick={() => { setResetOpen(true); setResetMsg(null); setError(null); }}
              className="rounded-md border border-red-300 px-3 py-1.5 text-sm text-red-700 hover:bg-red-50">
              Delete all financial data…
            </button>
          ) : (
            <div className="space-y-2">
              <label className="block text-xs">
                <span className="text-muted-foreground">
                  Type <span className="font-medium">{householdNameActual}</span> to confirm:
                </span>
                <input value={resetConfirm} onChange={(e) => setResetConfirm(e.target.value)}
                  placeholder={householdNameActual}
                  className="mt-1 w-full rounded-md border px-3 py-1.5 text-sm" />
              </label>
              <div className="flex items-center gap-2">
                <button onClick={resetData}
                  disabled={resetting || resetConfirm.trim() !== householdNameActual}
                  className="rounded-md bg-red-600 px-3 py-1.5 text-sm text-white hover:bg-red-700 disabled:opacity-50">
                  {resetting ? "Deleting…" : "Permanently delete"}
                </button>
                <button onClick={() => { setResetOpen(false); setResetConfirm(""); setError(null); }}
                  className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted">Cancel</button>
              </div>
            </div>
          )}
        </section>
      )}
    </PageContainer>
  );
}
