import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeftRight, ChevronDown, EyeOff, Pencil, Plus, Search, SlidersHorizontal, Trash2, Upload, Wallet, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import TransactionForm, {
  findDefaultAccountId,
  type TransactionPayload,
  type InitialTransaction,
  type Account,
  type Category,
} from "@/components/TransactionForm";
import MultiTransactionForm, { type BulkTransactionPayload, type InitialBulkRow } from "@/components/MultiTransactionForm";
import PendingAmazonDialog from "@/components/PendingAmazonDialog";
import { parseFormatACsv, parseFormatBCsv } from "@/lib/csvParsers";
import { dedupeRows, findPotentialDupes } from "@/lib/dedupe";
import AccountFilter from "@/components/AccountFilter";
import TransactionFilterPanel from "@/components/TransactionFilterPanel";
import { type TxType } from "@/lib/txType";
import { type DatePreset } from "@/lib/dateFilters";
import { useAdvancedFeatures } from "@/lib/features";
import { getDesktopBridge, type DesktopCloudStatus } from "@/lib/desktopBridge";
import { txAmountClass, txSign } from "@/lib/money";
import { monogram, monogramColor, dateGroupLabel } from "@/lib/rowVisual";
import { Skeleton } from "@/components/ui/skeleton";
import { useT } from "@/lib/i18n";
import Fab from "@/components/Fab";
import TagPicker from "@/components/TagPicker";
import OnboardingChecklist from "@/components/OnboardingChecklist";
import EncryptionPrompt from "@/components/EncryptionPrompt";

interface FullAccount extends Account {
  balance: number;
  balance_usd: number;
  market_value?: number | null;
}

interface Tag {
  id: number;
  name: string;
}

interface Transaction {
  id: number;
  account_id: number;
  account_name: string | null;
  category_id: number | null;
  category_name: string | null;
  date: string;
  description: string;
  amount_fx: number;
  exchange_rate: number;
  amount_usd: number;
  type: "debit" | "credit" | "transfer";
  transfer_group_id?: string | null;
  transfer_direction?: "out" | "in" | null;
  exclude_from_reports: boolean;
  created_at: string;
  transfer_from?: string | null;
  transfer_to?: string | null;
  tags: Tag[];
}

type DisplayRow =
  | { kind: "single"; tx: Transaction }
  | { kind: "pair"; from: Transaction; to: Transaction };

const USD = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
});

// Infinite scroll: fetch this many rows per request from the server, then load the
// next page each time the bottom sentinel scrolls into view. Keeps the page fast
// with thousands of transactions (loading the whole ledger froze the page for seconds).
const PAGE_SIZE = 100;
const MAX_CSV_FILE_BYTES = 10 * 1024 * 1024;

async function requireOk(response: Response, fallback: string): Promise<Response> {
  if (response.ok) return response;
  const body = await response.json().catch(() => ({} as { error?: string }));
  throw new Error(typeof body?.error === "string" ? body.error : fallback);
}

function formatDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${String(d).padStart(2, "0")} ${months[m - 1]} ${y}`;
}

// Render only the view that matches the viewport (CSS `hidden` would keep both
// the table and the list in the DOM, doubling thousands of row nodes).
function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia(query).matches
      : false
  );
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

// Account label for a single (unpaired) row: transfers render "from → to" using
// the counterparty the server resolved; everything else shows its own account.
function accountLabel(tx: Transaction): string | null {
  if (tx.type === "transfer" && tx.transfer_from && tx.transfer_to) {
    return `${tx.transfer_from} → ${tx.transfer_to}`;
  }
  return tx.account_name;
}

// Category to show in the ledger. Transfers have no category, but reading a
// blank/"Uncategorized" cell for them is confusing -- show the (translated)
// "Transfer" label passed in.
function categoryText(tx: Transaction, transferLabel: string): string | null {
  if (tx.type === "transfer") return transferLabel;
  return tx.category_name;
}

export default function Transactions() {
  const [accounts, setAccounts] = useState<FullAccount[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [allTags, setAllTags] = useState<Tag[]>([]);
  const advanced = useAdvancedFeatures();
  // Amazon matching needs the local scraper, so it only appears inside the
  // Balance Desktop shell. The bridge is injected at page load and never
  // changes, so a plain read (no state) is enough.
  const desktopBridge = getDesktopBridge() != null;
  const [cloudStatus, setCloudStatus] = useState<DesktopCloudStatus | null>(() =>
    getDesktopBridge()?.cloud ? null : { mode: "local", connecting: false }
  );
  const [txList, setTxList] = useState<Transaction[]>([]);
  const [selectedAccountIds, setSelectedAccountIds] = useState<Set<number>>(new Set());
  const [selectedCategoryIds, setSelectedCategoryIds] = useState<Set<number>>(new Set());
  const [uncategorizedOnly, setUncategorizedOnly] = useState(false);
  const [selectedTypes, setSelectedTypes] = useState<Set<TxType>>(new Set());
  const [datePreset, setDatePreset] = useState<DatePreset>("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [filterAmountMin, setFilterAmountMin] = useState("");
  const [filterAmountExact, setFilterAmountExact] = useState("");
  const [filterAmountMax, setFilterAmountMax] = useState("");
  const [filterTagId, setFilterTagId] = useState<string>("all");
  const [filterRecent, setFilterRecent] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [newTxType, setNewTxType] = useState<"debit" | "credit" | "transfer">("debit");
  const [multiFormOpen, setMultiFormOpen] = useState(false);
  const [pendingAmazonOpen, setPendingAmazonOpen] = useState(false);
  const [importedRows, setImportedRows] = useState<InitialBulkRow[]>([]);
  const [editingTx, setEditingTx] = useState<InitialTransaction | null>(null);
  const [importing, setImporting] = useState(false);
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const [loadingTx, setLoadingTx] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [transactionError, setTransactionError] = useState<string | null>(null);
  const [metadataError, setMetadataError] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  const formatAFileRef = useRef<HTMLInputElement>(null);
  const formatBFileRef = useRef<HTMLInputElement>(null);
  const budgetAppFileRef = useRef<HTMLInputElement>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const [bulkImportOpen, setBulkImportOpen] = useState(false);
  const [bulkBank, setBulkBank] = useState<"chase" | "bofa">("chase");
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [accountsDrawerOpen, setAccountsDrawerOpen] = useState(false);
  const isCompact = useMediaQuery("(max-width: 767px)");
  const t = useT();

  useEffect(() => {
    const cloud = getDesktopBridge()?.cloud;
    if (!cloud) return;
    let active = true;
    void cloud.status()
      .then((status) => { if (active) setCloudStatus(status); })
      .catch(() => { if (active) setCloudStatus({ mode: "local", connecting: false }); });
    return () => { active = false; };
  }, []);

  // Reloaded after any transaction change so the header balance stays in sync.
  // accountsLoaded gates the onboarding checklist so it never flashes while the
  // very first fetch is still in flight.
  const [accountsLoaded, setAccountsLoaded] = useState(false);
  async function refreshAccounts() {
    try {
      const response = await requireOk(await fetch("/api/accounts"), "Couldn't load accounts.");
      const data = await response.json();
      if (!Array.isArray(data)) throw new Error("Invalid accounts response");
      setAccounts(data);
      setAccountsLoaded(true);
    } catch {
      setMetadataError("Couldn't load accounts, categories, or labels. Please try again.");
    }
  }

  // Create a label inline (from any TagPicker) and make it immediately available.
  async function createTag(name: string): Promise<Tag | null> {
    try {
      const res = await requireOk(await fetch("/api/tags", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      }), "Couldn't create the label.");
      const tag = (await res.json()) as Tag;
      setAllTags((prev) => [...prev, tag]);
      return tag;
    } catch (cause) {
      setImportMsg(`Error: ${cause instanceof Error ? cause.message : "Couldn't create the label."}`);
      return null;
    }
  }

  useEffect(() => {
    setMetadataError(null);
    void refreshAccounts();
    void Promise.all([
      fetch("/api/categories").then((response) => requireOk(response, "Couldn't load categories.")).then((response) => response.json()),
      fetch("/api/tags").then((response) => requireOk(response, "Couldn't load labels.")).then((response) => response.json()),
    ]).then(([categoryRows, tagRows]) => {
      if (!Array.isArray(categoryRows) || !Array.isArray(tagRows)) throw new Error("Invalid lookup response");
      setCategories(categoryRows);
      setAllTags(tagRows);
    }).catch(() => setMetadataError("Couldn't load accounts, categories, or labels. Please try again."));
  }, []);

  // ── Server-side paginated loading ──────────────────────────────────────────
  // Fetch one PAGE_SIZE page at a time instead of the whole ledger (~18k rows /
  // ~4 MB). Filters are pushed to the server; the bottom sentinel requests the
  // next page on scroll. txList accumulates the loaded pages.
  const loadingRef = useRef(false);
  const seqRef = useRef(0);
  const txCountRef = useRef(0);
  const totalRef = useRef(0);
  useEffect(() => { txCountRef.current = txList.length; }, [txList]);
  useEffect(() => { totalRef.current = total; }, [total]);

  function buildFilterParams(): URLSearchParams {
    const p = new URLSearchParams();
    if (selectedAccountIds.size > 0) p.set("account_ids", [...selectedAccountIds].join(","));
    if (uncategorizedOnly) p.set("uncategorized", "1");
    else if (selectedCategoryIds.size > 0) p.set("category_ids", [...selectedCategoryIds].join(","));
    if (selectedTypes.size > 0) p.set("types", [...selectedTypes].join(","));
    if (dateFrom) p.set("date_from", dateFrom);
    if (dateTo) p.set("date_to", dateTo);
    if (filterAmountExact) {
      p.set("amount_min", filterAmountExact);
      p.set("amount_max", filterAmountExact);
    } else {
      if (filterAmountMin) p.set("amount_min", filterAmountMin);
      if (filterAmountMax) p.set("amount_max", filterAmountMax);
    }
    if (filterTagId !== "all") p.set("tag_id", filterTagId);
    if (filterRecent) p.set("recent", "1");
    if (search.trim()) p.set("search", search.trim());
    return p;
  }

  async function loadPage(reset: boolean) {
    // Appends wait their turn and stop at the end; a filter reset always proceeds
    // and supersedes any in-flight load (seq token discards the stale response).
    if (!reset && (loadingRef.current || (totalRef.current > 0 && txCountRef.current >= totalRef.current)))
      return;
    const seq = ++seqRef.current;
    loadingRef.current = true;
    if (reset) setLoadingTx(true); else setLoadingMore(true);
    const params = buildFilterParams();
    params.set("limit", String(PAGE_SIZE));
    params.set("offset", String(reset ? 0 : txCountRef.current));
    try {
      const r = await requireOk(
        await fetch(`/api/transactions?${params.toString()}`),
        "Couldn't load transactions.",
      );
      const d = await r.json();
      if (seq !== seqRef.current) return; // superseded by a newer load
      if (!Array.isArray(d?.rows) || !Number.isSafeInteger(d?.total) || d.total < 0) {
        throw new Error("The transaction list returned an invalid response.");
      }
      const rows: Transaction[] = d.rows;
      setTotal(d.total);
      setTxList((prev) => (reset ? rows : [...prev, ...rows]));
      setTransactionError(null);
    } catch {
      if (seq === seqRef.current) {
        setTransactionError("Couldn't load transactions. Please try again.");
      }
    } finally {
      if (seq === seqRef.current) {
        loadingRef.current = false;
        setLoadingTx(false);
        setLoadingMore(false);
      }
    }
  }
  const reload = () => loadPage(true);

  // Refetch from page 0 whenever the filters change (debounced so typing in the
  // amount inputs doesn't fire a request per keystroke). Also does the first load.
  useEffect(() => {
    const t = setTimeout(() => loadPage(true), 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedAccountIds, selectedCategoryIds, uncategorizedOnly, selectedTypes, dateFrom, dateTo, filterAmountMin, filterAmountExact, filterAmountMax, filterTagId, filterRecent, search]);

  // Group transfer pairs using their explicit direction. Legs that carry a
  // transfer_group_id pair exactly by it; the date+amount heuristic only
  // remains for legacy rows created before the link column existed.
  const displayRows = useMemo((): DisplayRow[] => {
    const transfers = txList.filter((t) => t.type === "transfer");
    const others = txList.filter((t) => t.type !== "transfer");
    const paired = new Set<number>();
    const rows: DisplayRow[] = others.map((tx) => ({ kind: "single", tx }));

    for (const tx of transfers) {
      if (paired.has(tx.id)) continue;
      const partner = transfers.find(
        (t) =>
          t.id !== tx.id &&
          !paired.has(t.id) &&
          (tx.transfer_group_id
            ? t.transfer_group_id === tx.transfer_group_id
            : !t.transfer_group_id &&
              t.date === tx.date &&
              Math.abs(t.amount_usd - tx.amount_usd) < 0.02 &&
              t.account_id !== tx.account_id)
      );
      if (partner) {
        paired.add(tx.id);
        paired.add(partner.id);
        const [from, to] = tx.transfer_direction === "out"
          ? [tx, partner]
          : partner.transfer_direction === "out"
            ? [partner, tx]
            : tx.id < partner.id ? [tx, partner] : [partner, tx];
        rows.push({ kind: "pair", from, to });
      } else {
        rows.push({ kind: "single", tx });
      }
    }

    return rows.sort((a, b) => {
      const da = a.kind === "pair" ? a.from.date : a.tx.date;
      const db = b.kind === "pair" ? b.from.date : b.tx.date;
      if (da !== db) return db.localeCompare(da);
      const ia = a.kind === "pair" ? a.from.id : a.tx.id;
      const ib = b.kind === "pair" ? b.from.id : b.tx.id;
      return ib - ia;
    });
  }, [txList]);

  // More pages remain on the server than we've loaded so far.
  const hasMore = txList.length < total;

  // Fetch the next page when the bottom sentinel scrolls into view.
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => { if (entries[0].isIntersecting) loadPage(false); },
      { rootMargin: "400px" }
    );
    io.observe(el);
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasMore]);

  // When exactly one account is filtered, use it as the default for CSV imports.
  const singleSelectedAccountId = selectedAccountIds.size === 1 ? [...selectedAccountIds][0] : null;

  // Labels (tags) live on their own join table, so they're written with a
  // separate PUT after the transaction itself is created/updated.
  async function putTags(txId: number, tagIds: number[]) {
    await requireOk(await fetch(`/api/tags/transaction/${txId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tag_ids: tagIds }),
    }), "failed to save labels");
  }

  async function handleSave(data: TransactionPayload, tagIds: number[]) {
   try {
    if (editingTx?.type === "transfer" && editingTx.transfer_group_id && data.to_account_id) {
      await requireOk(await fetch(`/api/transactions/transfer/${encodeURIComponent(editingTx.transfer_group_id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from_account_id: data.account_id,
          to_account_id: data.to_account_id,
          date: data.date,
          description: data.description,
          amount_fx: data.amount_fx,
        }),
      }), "failed to update transfer");
    } else if (editingTx) {
      await requireOk(await fetch(`/api/transactions/${editingTx.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }), "failed to update transaction");
      await putTags(editingTx.id, tagIds);
    } else if (data.type === "transfer" && data.to_account_id) {
      await requireOk(await fetch("/api/transactions/transfer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from_account_id: data.account_id,
          to_account_id: data.to_account_id,
          date: data.date,
          description: data.description,
          amount_fx: data.amount_fx,
        }),
      }), "failed to create transfer");
    } else {
      const res = await requireOk(await fetch("/api/transactions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }), "failed to create transaction");
      if (tagIds.length > 0) {
        const created = (await res.json()) as { id: number };
        await putTags(created.id, tagIds);
      }
    }
    setFormOpen(false);
    setEditingTx(null);
    refreshAccounts();
    reload();
   } catch (error) {
    setImportMsg(`Error: ${error instanceof Error ? error.message : "Couldn't save the transaction. Please try again."}`);
    throw error;
   }
  }

  // One atomic request for the whole batch (tags ride along per row) -- a
  // 200-row import used to be 200+ sequential POSTs with a partial ledger on
  // any mid-loop failure.
  async function handleMultiSave(rows: BulkTransactionPayload[]) {
    try {
      await requireOk(await fetch("/api/transactions/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows }),
      }), "failed to save transactions");
      setMultiFormOpen(false);
      refreshAccounts();
      reload();
    } catch (error) {
      setImportMsg(`Error: ${error instanceof Error ? error.message : "failed to save transactions"}`);
      throw error;
    }
  }

  function openAdd(type: "debit" | "credit" | "transfer") {
    setEditingTx(null);
    setNewTxType(type);
    setFormOpen(true);
  }

  function openEdit(tx: Transaction) {
    setEditingTx({
      id: tx.id,
      account_id: tx.account_id,
      category_id: tx.category_id,
      date: tx.date,
      description: tx.description,
      amount_fx: tx.amount_fx,
      exchange_rate: tx.exchange_rate,
      type: tx.type,
      exclude_from_reports: tx.exclude_from_reports,
      tag_ids: tx.tags.map((t) => t.id),
    });
    setFormOpen(true);
  }

  function openEditTransfer(from: Transaction, to: Transaction) {
    if (!from.transfer_group_id) {
      setImportMsg("This legacy transfer is incomplete and cannot be edited safely.");
      return;
    }
    setEditingTx({
      id: from.id,
      account_id: from.account_id,
      to_account_id: to.account_id,
      transfer_group_id: from.transfer_group_id,
      category_id: null,
      date: from.date,
      description: from.description,
      amount_fx: from.amount_fx,
      exchange_rate: from.exchange_rate,
      type: "transfer",
      exclude_from_reports: false,
      tag_ids: [],
    });
    setFormOpen(true);
  }

  // Flip the report-exclusion flag. Re-sends the full row so the server sees no
  // account/amount/type change → zero balance delta; only the flag updates.
  async function handleToggleExclude(tx: Transaction) {
    try {
      await requireOk(await fetch(`/api/transactions/${tx.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          account_id: tx.account_id, category_id: tx.category_id, date: tx.date,
          description: tx.description, amount_fx: tx.amount_fx, exchange_rate: tx.exchange_rate,
          amount_usd: tx.amount_usd, type: tx.type, exclude_from_reports: !tx.exclude_from_reports,
        }),
      }), "Couldn't update report inclusion.");
      setTxList((prev) => prev.map((t) => (t.id === tx.id ? { ...t, exclude_from_reports: !t.exclude_from_reports } : t)));
    } catch {
      setImportMsg("Error: Couldn't update report inclusion. Please try again.");
    }
  }

  async function handleDelete(ids: number[]) {
    try {
      if (ids.length === 0) return;
      if (!confirm("Delete this transaction? Linked transfer entries are removed together.")) return;
      await requireOk(await fetch(`/api/transactions/${ids[0]}`, { method: "DELETE" }), "failed to delete transaction");
      refreshAccounts();
      reload();
    } catch {
      setImportMsg("Error: Couldn't delete the transaction. Please try again.");
    }
  }

  async function handleTagChange(txId: number, tagIds: number[]) {
    try {
      await requireOk(await fetch(`/api/tags/transaction/${txId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tag_ids: tagIds }),
      }), "Couldn't update labels.");
      setTxList((prev) =>
        prev.map((tx) =>
          tx.id === txId ? { ...tx, tags: allTags.filter((t) => tagIds.includes(t.id)) } : tx
        )
      );
    } catch {
      setImportMsg("Error: Couldn't update labels. Please try again.");
    }
  }

  function dedupeAgainstExisting(parsed: ReturnType<typeof parseFormatACsv>, defAccId: string | undefined, existing: Transaction[]) {
    if (!defAccId) return { rows: parsed, skipped: 0, warnings: parsed.map(() => null) };
    const accIdNum = Number(defAccId);
    const sameAccount = existing.filter(t => t.account_id === accIdNum);
    const { rows, skipped } = dedupeRows(parsed, sameAccount, 0);
    // Flag (don't drop) cross-account potential duplicates within ±5 days.
    const otherAccounts = existing.filter(t => t.account_id !== accIdNum);
    const warnings = findPotentialDupes(rows, otherAccounts, 5);
    return { rows, skipped, warnings };
  }

  // Merchant-memory prefill: ask the server which category this household last
  // used for each imported description, so rows don't all land Uncategorized.
  // The user still reviews (and can correct) every suggestion in the bulk form
  // before anything is saved. Best-effort -- on any failure, no suggestions.
  async function suggestCategoriesFor(descriptions: string[]): Promise<(number | null)[]> {
    try {
      const res = await fetch("/api/transactions/suggest-categories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ descriptions }),
      });
      if (!res.ok) return descriptions.map(() => null);
      const d = (await res.json()) as { suggestions?: (number | null)[] };
      return Array.isArray(d.suggestions) ? d.suggestions : descriptions.map(() => null);
    } catch {
      return descriptions.map(() => null);
    }
  }

  async function handleCsvImport(e: React.ChangeEvent<HTMLInputElement>, parse: typeof parseFormatACsv) {
    const input = e.currentTarget;
    const file = input.files?.[0];
    if (!file) return;
    setImporting(true);
    setImportMsg(null);
    try {
      if (file.size > MAX_CSV_FILE_BYTES) throw new Error("CSV files must be 10 MB or smaller.");
      const text = await file.text();
      const parsed = parse(text);
      const defAccId = singleSelectedAccountId
        ? String(singleSelectedAccountId)
        : findDefaultAccountId(accounts) || undefined;
      if (parsed.length === 0) {
        setImportMsg("No valid transactions were found in that file.");
        return;
      }
      const existingResponse = await requireOk(
        await fetch("/api/transactions?limit=-1"),
        "failed to check existing transactions",
      );
      const existingBody = await existingResponse.json() as { rows?: Transaction[] };
      const existing = Array.isArray(existingBody.rows) ? existingBody.rows : [];
      const { rows, skipped, warnings } = dedupeAgainstExisting(parsed, defAccId, existing);
      if (skipped > 0) setImportMsg(`${skipped} duplicate${skipped > 1 ? "s" : ""} skipped`);
      if (rows.length === 0) return;
      const suggestions = await suggestCategoriesFor(rows.map((r) => r.description));
      setImportedRows(rows.map((r, i) => ({
        ...r,
        account_id: defAccId,
        category_id: suggestions[i] ?? null,
        dupe_warning: warnings[i] ?? null,
      })));
      setMultiFormOpen(true);
    } catch (error) {
      setImportMsg(`Error: ${error instanceof Error ? error.message : "Couldn't read that CSV file."}`);
    } finally {
      setImporting(false);
      input.value = "";
    }
  }

  const handleFormatAImport = (e: React.ChangeEvent<HTMLInputElement>) => handleCsvImport(e, parseFormatACsv);
  const handleFormatBImport = (e: React.ChangeEvent<HTMLInputElement>) => handleCsvImport(e, parseFormatBCsv);

  async function handleBudgetAppImport(e: React.ChangeEvent<HTMLInputElement>) {
    const input = e.currentTarget;
    const file = input.files?.[0];
    if (!file) return;
    setImporting(true);
    setImportMsg(null);
    try {
      if (file.size > MAX_CSV_FILE_BYTES) throw new Error("CSV files must be 10 MB or smaller.");
      const csv_text = await file.text();
      const res = await fetch("/api/transactions/import-budget-app", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ csv_text }),
      });
      const json = await res.json() as { imported?: number; skipped?: number; unmapped?: string[]; error?: string };
      if (!res.ok) throw new Error(json.error ?? "Couldn't import that CSV file.");
      const msg = `Imported ${json.imported} transactions${json.skipped ? `, ${json.skipped} skipped` : ""}`;
      setImportMsg(json.unmapped?.length ? `${msg}. Unmapped: ${json.unmapped.join(", ")}` : msg);
      await refreshAccounts();
      reload();
    } catch (error) {
      setImportMsg(`Error: ${error instanceof Error ? error.message : "Couldn't import that CSV file."}`);
    } finally {
      setImporting(false);
      input.value = "";
    }
  }

  const hasFilters = selectedAccountIds.size > 0 || selectedCategoryIds.size > 0 || uncategorizedOnly
    || selectedTypes.size > 0 || !!dateFrom || !!dateTo || !!filterAmountMin || !!filterAmountExact || !!filterAmountMax
    || filterTagId !== "all" || filterRecent;

  // Number of distinct active filter groups -- shown as a badge on the Filter button.
  const activeFilterCount =
    (selectedAccountIds.size > 0 ? 1 : 0) +
    (uncategorizedOnly || selectedCategoryIds.size > 0 ? 1 : 0) +
    (selectedTypes.size > 0 ? 1 : 0) +
    (dateFrom || dateTo ? 1 : 0) +
    (filterAmountMin || filterAmountExact || filterAmountMax ? 1 : 0) +
    (filterTagId !== "all" ? 1 : 0) +
    (filterRecent ? 1 : 0);

  function clearFilters() {
    setSelectedAccountIds(new Set());
    setSelectedCategoryIds(new Set());
    setUncategorizedOnly(false);
    setSelectedTypes(new Set());
    setDatePreset("all");
    setDateFrom("");
    setDateTo("");
    setFilterAmountMin("");
    setFilterAmountExact("");
    setFilterAmountMax("");
    setFilterTagId("all");
    setFilterRecent(false);
  }

  return (
    <div className="min-h-screen bg-background">
      <input ref={formatAFileRef} type="file" accept=".csv" className="hidden" onChange={handleFormatAImport} />
      <input ref={formatBFileRef} type="file" accept=".csv" className="hidden" onChange={handleFormatBImport} />
      <input ref={budgetAppFileRef} type="file" accept=".csv" className="hidden" onChange={handleBudgetAppImport} />

      {/* Sticky header + filter bar. On desktop it sticks below the top nav bar (h-14).
          The bar spans full width (border) but its content is centered to the page width. */}
      <div className="sticky top-0 md:top-14 z-20 bg-background border-b">
        <div className="mx-auto w-full max-w-6xl px-4 sm:px-6 pt-3 pb-2 space-y-2">

        {/* Optional context line: the selected account's balance */}
        {selectedAccountIds.size === 1 && (() => {
          const acc = accounts.find(a => a.id === [...selectedAccountIds][0]);
          if (!acc) return null;
          const val = acc.account_type === "RSU" && acc.market_value != null
            ? acc.market_value
            : acc.balance_usd;
          return (
            <p className="text-sm text-muted-foreground truncate">
              {acc.name}&nbsp;&nbsp;&nbsp;&nbsp;{USD.format(val)}
            </p>
          );
        })()}

        {/* Toolbar -- one horizontal line: Filter · Clear · Search · Add · Add Multiple · Bulk Import.
            The search flexes (min-w-0 flex-1) and every button is shrink-0, so nothing ever wraps
            to a second line on any width; the search just narrows to make room. */}
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" className="shrink-0" onClick={() => setFilterOpen(true)}>
            <SlidersHorizontal className="w-4 h-4 mr-1" /> {t("tx.filter")}
            {activeFilterCount > 0 && (
              <span className="ml-1.5 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground">
                {activeFilterCount}
              </span>
            )}
          </Button>
          {hasFilters && (
            <Button variant="ghost" size="sm" onClick={clearFilters} className="shrink-0 px-2 text-muted-foreground" aria-label="Clear filter">
              <X className="w-4 h-4 sm:mr-1" /> <span className="hidden sm:inline">Clear</span>
            </Button>
          )}
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("tx.searchPlaceholder")}
              className="h-9 w-full pl-8"
            />
          </div>

          {/* Desktop-only: on mobile the FAB is the single add entry point. */}
          <Button size="sm" className="hidden shrink-0 md:inline-flex" onClick={() => openAdd("debit")}>
            <Plus className="w-4 h-4 mr-1" /> {t("common.add")}
          </Button>

          {/* Inline secondary actions (wide) */}
          <div className="hidden shrink-0 items-center gap-2 xl:flex">
            <Button size="sm" variant="outline" onClick={() => setMultiFormOpen(true)}>
              <Plus className="w-4 h-4 mr-1" /> {t("tx.addMultiple")}
            </Button>
            <Button variant="outline" size="sm" disabled={importing} onClick={() => setBulkImportOpen(true)}>
              <Upload className="w-4 h-4 mr-1" /> {t("tx.bulkImport")}
            </Button>
          </div>

          {/* Overflow menu (compact): Add Multiple + Bulk Import */}
          <Popover open={addMenuOpen} onOpenChange={setAddMenuOpen}>
            <PopoverTrigger asChild>
              <Button variant="outline" size="sm" className="shrink-0 px-2 xl:hidden" disabled={importing} aria-label="More add options">
                <ChevronDown className="w-4 h-4" />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="p-1 w-52" align="end">
              <button onClick={() => { setAddMenuOpen(false); setMultiFormOpen(true); }}
                className="w-full text-left px-3 py-1.5 text-sm rounded hover:bg-muted">
                {t("tx.addMultiple")}
              </button>
              <button onClick={() => { setAddMenuOpen(false); setBulkImportOpen(true); }}
                className="w-full text-left px-3 py-1.5 text-sm rounded hover:bg-muted">
                {t("tx.bulkImport")}…
              </button>
            </PopoverContent>
          </Popover>

          {/* Accounts drawer trigger -- only below lg, where the persistent rail is hidden. */}
          <Button variant="outline" size="sm" className="shrink-0 px-2 lg:hidden"
            onClick={() => setAccountsDrawerOpen(true)} aria-label="Accounts">
            <Wallet className="w-4 h-4" />
          </Button>
        </div>

        </div>
      </div>

      {/* Content. Extra bottom padding on mobile so the FAB never covers the last row. */}
      <div className="mx-auto w-full max-w-6xl px-4 sm:px-6 pt-4 pb-24 md:pb-4">
        {/* First-run checklist: only once both initial fetches settled and no
            filters are active (a filtered-to-empty ledger is not a new household). */}
        {accountsLoaded && !loadingTx && cloudStatus && !cloudStatus.connecting && !hasFilters && !search.trim() && (
          <OnboardingChecklist
            accountCount={accounts.length}
            transactionCount={total}
            isCloudProfile={cloudStatus.mode === "cloud"}
            onSampleLoaded={() => { refreshAccounts(); reload(); }}
          />
        )}
        {/* Encryption is opt-in, so the offer (and the macOS Keychain prompt it
            raises) waits until there is a ledger and the checklist is done. */}
        {accountsLoaded && !loadingTx && (
          <EncryptionPrompt hasLedgerData={accounts.length > 0 && total > 0} />
        )}
        {importMsg && (
          <div role={importMsg.startsWith("Error") ? "alert" : "status"} className={cn(
            "mb-3 flex items-start justify-between gap-3 rounded-lg border px-3 py-2 text-sm",
            importMsg.startsWith("Error")
              ? "border-red-300 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300"
              : "border-green-300 bg-green-50 text-green-700 dark:border-green-900 dark:bg-green-950/30 dark:text-green-300",
          )}>
            <span>{importMsg}</span>
            <button onClick={() => setImportMsg(null)} aria-label="Dismiss" className="shrink-0 opacity-70 hover:opacity-100">
              <X className="h-4 w-4" />
            </button>
          </div>
        )}
        {transactionError && (
          <div role="alert" className="mb-3 flex items-center justify-between gap-3 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
            <span>{transactionError}</span>
            <button type="button" onClick={reload} className="shrink-0 font-medium underline underline-offset-2">Try again</button>
          </div>
        )}
        {metadataError && (
          <div role="alert" className="mb-3 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
            {metadataError}
          </div>
        )}

        <div className="lg:flex lg:gap-5 lg:items-start">
          <div className="flex-1 min-w-0">
            {transactionError && txList.length === 0 ? null : loadingTx && txList.length === 0 ? (
              <div className="rounded-lg border divide-y">
                {Array.from({ length: 8 }).map((_, i) => (
                  <div key={i} className="flex items-center gap-3 px-4 py-3">
                    <Skeleton className="h-10 w-10 shrink-0 rounded-full" />
                    <div className="min-w-0 flex-1 space-y-2">
                      <Skeleton className="h-3.5 w-1/3" />
                      <Skeleton className="h-3 w-1/2" />
                    </div>
                    <Skeleton className="h-4 w-16 shrink-0" />
                  </div>
                ))}
              </div>
            ) : displayRows.length === 0 ? (
              <div className="rounded-lg border px-6 py-12 text-center">
                {hasFilters ? (
                  <p className="text-sm text-muted-foreground">{t("tx.emptyFiltered")}</p>
                ) : (
                  <div className="space-y-3">
                    <p className="text-sm text-muted-foreground">{t("tx.emptyNoFilters")}</p>
                    <Button size="sm" onClick={() => openAdd("debit")}>
                      <Plus className="mr-1 h-4 w-4" /> {t("tx.addTransaction")}
                    </Button>
                  </div>
                )}
              </div>
            ) : (
              <>
                {/* Table view (>= 768px) */}
                {!isCompact && (
                <div className="rounded-lg border overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="whitespace-nowrap">{t("tx.col.date")}</TableHead>
                        <TableHead className="text-right whitespace-nowrap">{t("tx.col.amount")}</TableHead>
                        <TableHead>{t("tx.col.category")}</TableHead>
                        <TableHead className="whitespace-nowrap">{t("tx.col.account")}</TableHead>
                        <TableHead>{t("tx.col.labels")}</TableHead>
                        <TableHead className="whitespace-nowrap">{t("tx.col.type")}</TableHead>
                        <TableHead className="w-16" />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {displayRows.map((row) => {
                        if (row.kind === "pair") {
                          const { from, to } = row;
                          return (
                            <TableRow key={`pair-${from.id}`} className="group">
                              <TableCell className="text-sm tabular-nums text-muted-foreground whitespace-nowrap">
                                {formatDate(from.date)}
                              </TableCell>
                              <TableCell className="text-right text-sm font-semibold tabular-nums">
                                {USD.format(from.amount_usd)}
                              </TableCell>
                              <TableCell className="text-sm">
                                <div>{t("txType.transfer")}</div>
                                {from.description && (
                                  <div className="line-clamp-1 break-words text-xs text-muted-foreground" title={from.description}>{from.description}</div>
                                )}
                              </TableCell>
                              <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                                {from.account_name} → {to.account_name}
                              </TableCell>
                              <TableCell />
                              <TableCell>
                                <Badge variant="outline" className="text-xs">{t("txType.transfer")}</Badge>
                              </TableCell>
                              <TableCell>
                                <div className="flex items-center gap-0.5 opacity-70 transition-opacity group-hover:opacity-100">
                                  <Button aria-label="Edit transfer" variant="ghost" size="icon" className="h-7 w-7" onClick={() => openEditTransfer(from, to)}>
                                    <Pencil className="w-3.5 h-3.5" />
                                  </Button>
                                  <Button aria-label="Delete transfer" variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-destructive" onClick={() => handleDelete([from.id])}>
                                    <Trash2 className="w-3.5 h-3.5" />
                                  </Button>
                                </div>
                              </TableCell>
                            </TableRow>
                          );
                        }

                        const { tx } = row;
                        const catText = categoryText(tx, t("txType.transfer"));
                        return (
                          <TableRow key={tx.id} className={cn("group", tx.exclude_from_reports && "opacity-60")}>
                            <TableCell className="text-sm tabular-nums text-muted-foreground whitespace-nowrap">
                              {formatDate(tx.date)}
                            </TableCell>
                            <TableCell
                              aria-label={`${t(`txType.${tx.type}`)} ${USD.format(tx.amount_usd)}`}
                              className={cn(
                                "text-right text-sm font-semibold tabular-nums whitespace-nowrap",
                                txAmountClass(tx.type)
                              )}>
                              {txSign(tx.type)}{USD.format(tx.amount_usd)}
                            </TableCell>
                            <TableCell className="text-sm">
                              {/* Category is the primary line; the merchant/note (description) is
                                  a secondary line shown only when the user actually entered one. */}
                              <div className="line-clamp-2 break-words">
                                {catText
                                  ? catText
                                  : tx.description
                                    ? tx.description
                                    : <span className="text-muted-foreground">{t("tx.uncategorized")}</span>}
                              </div>
                              <div className="flex items-center gap-1.5">
                                {tx.category_name && tx.description && (
                                  <span className="text-xs text-muted-foreground line-clamp-1" title={tx.description}>{tx.description}</span>
                                )}
                                {tx.exclude_from_reports && (
                                  <Badge variant="outline" className="text-[10px] gap-1 text-amber-600 border-amber-300">
                                    <EyeOff className="w-2.5 h-2.5" /> {t("tx.notInReports")}
                                  </Badge>
                                )}
                              </div>
                            </TableCell>
                            <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                              {accountLabel(tx)}
                            </TableCell>
                            <TableCell className="w-[180px] max-w-[180px]">
                              <TagPicker
                                singleLine
                                allTags={allTags}
                                selectedIds={tx.tags.map((t) => t.id)}
                                onChange={(ids) => handleTagChange(tx.id, ids)}
                                onCreate={createTag}
                              />
                            </TableCell>
                            <TableCell>
                              <Badge variant="outline" className="text-xs">
                                {t(`txType.${tx.type}`)}
                              </Badge>
                            </TableCell>
                            <TableCell>
                              <div className="flex items-center gap-0.5">
                                {/* Exclude-from-reports toggle -- advanced power users only. */}
                                {advanced && (
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className={cn("h-7 w-7", tx.exclude_from_reports
                                    ? "text-amber-600 hover:text-amber-700"
                                    : "text-muted-foreground opacity-0 group-hover:opacity-100")}
                                  title={tx.exclude_from_reports ? "Excluded from reports -- click to include" : "Exclude from reports"}
                                  aria-label={tx.exclude_from_reports ? "Include transaction in reports" : "Exclude transaction from reports"}
                                  onClick={() => handleToggleExclude(tx)}
                                >
                                  <EyeOff className="w-3.5 h-3.5" />
                                </Button>
                                )}
                                <div className="flex items-center gap-0.5 opacity-70 transition-opacity group-hover:opacity-100">
                                  <Button aria-label="Edit transaction" variant="ghost" size="icon" className="h-7 w-7" onClick={() => openEdit(tx)}>
                                    <Pencil className="w-3.5 h-3.5" />
                                  </Button>
                                  <Button aria-label="Delete transaction" variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-destructive" onClick={() => handleDelete([tx.id])}>
                                    <Trash2 className="w-3.5 h-3.5" />
                                  </Button>
                                </div>
                              </div>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
                )}

                {/* List view (< 768px): tappable rows open the edit form */}
                {isCompact && (
                <div className="rounded-lg border divide-y">
                  {(() => {
                    // Rows are date-desc; insert a date-group header whenever the day
                    // changes ("Today" / "Yesterday" / "12 Jun 2025").
                    let lastDate: string | null = null;
                    const out: React.ReactNode[] = [];
                    for (const row of displayRows) {
                      const rowDate = row.kind === "pair" ? row.from.date : row.tx.date;
                      if (rowDate !== lastDate) {
                        lastDate = rowDate;
                        out.push(
                          <div key={`h-${rowDate}`} className="bg-muted/40 px-4 py-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                            {dateGroupLabel(rowDate)}
                          </div>,
                        );
                      }
                      if (row.kind === "pair") {
                        const { from, to } = row;
                        out.push(
                          <button
                            key={`m-pair-${from.id}`}
                            onClick={() => openEditTransfer(from, to)}
                            className="flex w-full items-center gap-3 px-4 py-2.5 text-left min-h-[44px] active:bg-muted"
                          >
                            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-secondary text-muted-foreground">
                              <ArrowLeftRight className="h-4 w-4" />
                            </span>
                            <div className="min-w-0 flex-1">
                              <div className="truncate text-sm font-medium">{from.description || t("txType.transfer")}</div>
                              <div className="truncate text-xs text-muted-foreground">{from.account_name} → {to.account_name}</div>
                            </div>
                            <div className="shrink-0 whitespace-nowrap text-base font-semibold tabular-nums"
                              aria-label={`${t("txType.transfer")} ${USD.format(from.amount_usd)}`}>
                              {USD.format(from.amount_usd)}
                            </div>
                          </button>,
                        );
                        continue;
                      }
                      const { tx } = row;
                      const catText = categoryText(tx, t("txType.transfer"));
                      const monoLabel = catText || tx.description || t("tx.uncategorized");
                      const sub = [accountLabel(tx), catText].filter(Boolean).join(" · ");
                      out.push(
                        <button
                          key={`m-${tx.id}`}
                          onClick={() => openEdit(tx)}
                          className={cn(
                            "flex w-full items-center gap-3 px-4 py-2.5 text-left min-h-[44px] active:bg-muted",
                            tx.exclude_from_reports && "opacity-60",
                          )}
                        >
                          <span className={cn("flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-xs font-semibold", monogramColor(monoLabel))}>
                            {monogram(monoLabel)}
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm font-medium">{tx.description || catText || "--"}</div>
                            <div className="truncate text-xs text-muted-foreground">{sub}</div>
                          </div>
                          <div className={cn("shrink-0 whitespace-nowrap text-base font-semibold tabular-nums", txAmountClass(tx.type))}
                            aria-label={`${t(`txType.${tx.type}`)} ${USD.format(tx.amount_usd)}`}>
                            {txSign(tx.type)}{USD.format(tx.amount_usd)}
                          </div>
                        </button>,
                      );
                    }
                    return out;
                  })()}
                </div>
                )}
              </>
            )}

            {hasMore && (
              <div ref={sentinelRef} className="py-3 text-center text-xs text-muted-foreground">
                {loadingMore ? t("tx.loadingMore") : t("tx.scrollForMore")} ({txList.length} / {total})
              </div>
            )}
          </div>

          {/* Persistent accounts rail (>= 1280px) */}
          <aside className="hidden lg:block w-52 shrink-0 rounded-lg border p-3">
            <AccountFilter
              accounts={accounts}
              selected={selectedAccountIds}
              onChange={setSelectedAccountIds}
            />
          </aside>
        </div>
      </div>

      {/* Consolidated filter -- a centered popup, like Add Multiple Transactions */}
      <Dialog open={filterOpen} onOpenChange={setFilterOpen}>
        <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Filter transactions</DialogTitle>
          </DialogHeader>
          <TransactionFilterPanel
            categories={categories}
            allTags={allTags}
            advanced={advanced}
            datePreset={datePreset} setDatePreset={setDatePreset}
            dateFrom={dateFrom} setDateFrom={setDateFrom}
            dateTo={dateTo} setDateTo={setDateTo}
            selectedTypes={selectedTypes} setSelectedTypes={setSelectedTypes}
            selectedCategoryIds={selectedCategoryIds} setSelectedCategoryIds={setSelectedCategoryIds}
            uncategorizedOnly={uncategorizedOnly} setUncategorizedOnly={setUncategorizedOnly}
            filterTagId={filterTagId} setFilterTagId={setFilterTagId}
            amountMin={filterAmountMin} setAmountMin={setFilterAmountMin}
            amountExact={filterAmountExact} setAmountExact={setFilterAmountExact}
            amountMax={filterAmountMax} setAmountMax={setFilterAmountMax}
            recent={filterRecent} setRecent={setFilterRecent}
            onClear={clearFilters}
          />
        </DialogContent>
      </Dialog>

      {/* Bulk import -- pick the bank, then the CSV file */}
      <Dialog open={bulkImportOpen} onOpenChange={setBulkImportOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Bulk import from CSV</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <p className="text-sm font-medium">Which bank is this CSV from?</p>
              <div className="grid grid-cols-2 gap-2">
                <Button variant={bulkBank === "chase" ? "default" : "outline"} onClick={() => setBulkBank("chase")}>Chase</Button>
                <Button variant={bulkBank === "bofa" ? "default" : "outline"} onClick={() => setBulkBank("bofa")}>Bank of America</Button>
              </div>
            </div>
            <Button
              className="w-full"
              disabled={importing}
              onClick={() => {
                setBulkImportOpen(false);
                (bulkBank === "chase" ? formatAFileRef : formatBFileRef).current?.click();
              }}
            >
              <Upload className="w-4 h-4 mr-1" /> Choose CSV file…
            </Button>
            {(advanced || desktopBridge) && (
              <div className="space-y-2 border-t pt-3">
                <p className="text-xs uppercase tracking-widest text-muted-foreground">Experimental</p>
                {advanced && (
                  <Button variant="outline" className="w-full" onClick={() => { setBulkImportOpen(false); budgetAppFileRef.current?.click(); }}>
                    Existing ledger CSV
                  </Button>
                )}
                {desktopBridge && (
                  <Button variant="outline" className="w-full" onClick={() => { setBulkImportOpen(false); setPendingAmazonOpen(true); }}>
                    Pending Amazon
                  </Button>
                )}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Accounts drawer (< 1280px): slides down from the top */}
      <Sheet open={accountsDrawerOpen} onOpenChange={setAccountsDrawerOpen}>
        <SheetContent side="top" className="lg:hidden">
          <SheetTitle className="sr-only">Accounts</SheetTitle>
          <AccountFilter
            accounts={accounts}
            selected={selectedAccountIds}
            onChange={setSelectedAccountIds}
            onSelect={() => setAccountsDrawerOpen(false)}
          />
        </SheetContent>
      </Sheet>

      {/* One-tap entry: coral FAB → speed dial (mobile). */}
      <Fab
        actions={[
          { label: t("txType.debit"), onClick: () => openAdd("debit") },
          { label: t("txType.credit"), onClick: () => openAdd("credit") },
          { label: t("txType.transfer"), onClick: () => openAdd("transfer") },
        ]}
        label={t("tx.addTransaction")}
      />

      <TransactionForm
        open={formOpen}
        onClose={() => { setFormOpen(false); setEditingTx(null); }}
        onSave={handleSave}
        accounts={accounts}
        categories={categories}
        allTags={allTags}
        onCreateTag={createTag}
        defaultAccountId={singleSelectedAccountId ?? undefined}
        initial={editingTx ?? undefined}
        defaultType={newTxType}
        title={editingTx ? "Edit Transaction" : "Add Transaction"}
      />
      <MultiTransactionForm
        open={multiFormOpen}
        onClose={() => { setMultiFormOpen(false); setImportedRows([]); }}
        onSave={handleMultiSave}
        accounts={accounts}
        categories={categories}
        allTags={allTags}
        onCreateTag={createTag}
        defaultAccountId={singleSelectedAccountId ?? undefined}
        initialRows={importedRows.length > 0 ? importedRows : undefined}
      />
      <PendingAmazonDialog
        open={pendingAmazonOpen}
        onClose={() => setPendingAmazonOpen(false)}
        onImport={(rows) => { setImportedRows(rows); setPendingAmazonOpen(false); setMultiFormOpen(true); }}
      />
    </div>
  );
}
