import { useEffect, useState } from "react";
import { Plus, X } from "lucide-react";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogHeader, DialogFooter, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import { balanceClass } from "@/lib/money";
import AccountForm, { type AccountPayload } from "@/components/AccountForm";
import PageContainer from "@/components/PageContainer";
import { Skeleton } from "@/components/ui/skeleton";
import { useT } from "@/lib/i18n";
import { getMe } from "@/lib/api";
import SortableAccountRow, {
  type Account,
  effectiveValue,
} from "@/components/SortableAccountRow";
import { ACCOUNT_GROUPS as GROUPS, type AccountGroupKey as GroupKey } from "@/lib/accountGroups";

const USD = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
});

export default function Accounts() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Account | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Account | null>(null);
  const [baseCurrency, setBaseCurrency] = useState("USD");
  const [actionError, setActionError] = useState<string | null>(null);
  const t = useT();

  const sensors = useSensors(useSensor(PointerSensor));

  function loadAccounts() {
    return fetch("/api/accounts")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<Account[]>;
      })
      .then((rows) => {
        setAccounts(rows);
        setError(null);
      })
      .catch((err: Error) => setError(err.message));
  }

  useEffect(() => {
    loadAccounts().finally(() => setLoading(false));
    getMe().then((m) => { if (m?.household?.base_currency) setBaseCurrency(m.household.base_currency); }).catch(() => {});
  }, []);

  async function handleSave(data: AccountPayload) {
    try {
      const res = editing
        ? await fetch(`/api/accounts/${editing.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(data),
          })
        : await fetch("/api/accounts", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(data),
          });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? "Couldn't save the account.");
      }
      await loadAccounts();
      setFormOpen(false);
      setEditing(null);
      setActionError(null);
    } catch (error) {
      throw error instanceof Error ? error : new Error("Couldn't save the account. Please try again.");
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    try {
      const res = await fetch(`/api/accounts/${deleteTarget.id}`, { method: "DELETE" });
      if (!res.ok) {
        setDeleteTarget(null);
        setActionError("Couldn't delete the account.");
        return;
      }
      setDeleteTarget(null);
      await loadAccounts();
    } catch {
      setDeleteTarget(null);
      setActionError("Couldn't delete the account. Please try again.");
    }
  }

  async function handleDragEnd(event: DragEndEvent, groupKey: GroupKey) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const group = GROUPS.find((g) => g.key === groupKey)!;
    const groupAccounts = accounts.filter(group.filter);
    const oldIndex = groupAccounts.findIndex((a) => a.id === active.id);
    const newIndex = groupAccounts.findIndex((a) => a.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    const reordered = arrayMove(groupAccounts, oldIndex, newIndex);

    // Optimistic update -- preserve all other accounts
    const previousAccounts = accounts;
    const otherAccounts = accounts.filter((a) => !group.filter(a));
    setAccounts([...otherAccounts, ...reordered]);

    const order = reordered.map((a, i) => ({ id: a.id, sort_order: i }));
    try {
      const response = await fetch("/api/accounts/reorder", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ order }),
      });
      if (!response.ok) throw new Error("Couldn't save the account order.");
      setActionError(null);
    } catch {
      setAccounts(previousAccounts);
      setActionError("Couldn't save the account order. Your previous order was restored.");
    }
  }

  // Net worth always counts every account (inactive included, per design).
  const totalNetWorth = accounts.reduce((sum, a) => sum + effectiveValue(a), 0);
  // Net-worth breakdown by liquidity group (a partition, so it sums to net worth) --
  // surfaced in the desktop summary panel.
  const netWorthBreakdown = GROUPS
    .map((g) => ({ label: t(`accountGroup.${g.key}`), total: accounts.filter(g.filter).reduce((s, a) => s + effectiveValue(a), 0) }))
    .filter((g) => g.total !== 0);
  // Inactive accounts are hidden from the lists unless the toggle is on.
  const inactiveCount = accounts.filter((a) => a.is_active === false).length;
  const visibleAccounts = showInactive
    ? accounts
    : accounts.filter((a) => a.is_active !== false);

  if (loading) {
    return (
      <PageContainer className="max-w-5xl py-6 space-y-6">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-10 w-56" />
        <div className="space-y-4">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex items-center justify-between py-3">
              <div className="space-y-2">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-3 w-20" />
              </div>
              <Skeleton className="h-4 w-20" />
            </div>
          ))}
        </div>
      </PageContainer>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <p className="text-red-500">Error: {error}</p>
      </div>
    );
  }

  return (
    <PageContainer className="max-w-5xl py-6 space-y-6">
      {actionError && (
        <div className="flex items-start justify-between gap-3 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
          <span>{actionError}</span>
          <button onClick={() => setActionError(null)} aria-label="Dismiss" className="shrink-0 opacity-70 hover:opacity-100">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">{t("nav.accounts")}</h1>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={() => setEditMode((v) => !v)}>
            {editMode ? t("common.done") : t("common.edit")}
          </Button>
          {!editMode && (
            <Button onClick={() => { setEditing(null); setFormOpen(true); }} size="sm">
              <Plus className="w-4 h-4 mr-1" /> {t("accounts.addAccount")}
            </Button>
          )}
        </div>
      </div>

      <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_16rem] lg:items-start lg:gap-8">
      {/* Main column: net-worth headline (mobile), inactive toggle, account groups. */}
      <div className="min-w-0 space-y-6">
      {/* Net worth headline -- shown on mobile/tablet; desktop uses the side panel. */}
      <div className="lg:hidden">
        <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">{t("accounts.netWorth")}</p>
        <p className={`mt-1 text-4xl font-bold tabular-nums ${balanceClass(totalNetWorth)}`}>{USD.format(totalNetWorth)}</p>
      </div>

      {inactiveCount > 0 && (
        <div className="flex justify-end">
          <Button variant="ghost" size="sm" onClick={() => setShowInactive((v) => !v)}>
            {showInactive ? t("accounts.hideInactive") : `${t("accounts.showInactive")} (${inactiveCount})`}
          </Button>
        </div>
      )}

      {GROUPS.map(({ key, filter }) => {
        const groupAccounts = visibleAccounts.filter(filter);
        if (groupAccounts.length === 0) return null;
        const groupTotal = groupAccounts.reduce((s, a) => s + effectiveValue(a), 0);

        return (
          <section key={key} className="space-y-1">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold">{t(`accountGroup.${key}`)}</h2>
              <span className={`text-sm font-medium tabular-nums ${balanceClass(groupTotal) || "text-muted-foreground"}`}>
                {USD.format(groupTotal)}
              </span>
            </div>
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={(e) => handleDragEnd(e, key)}
            >
              <SortableContext
                items={groupAccounts.map((a) => a.id)}
                strategy={verticalListSortingStrategy}
              >
                <div className="divide-y divide-border">
                  {groupAccounts.map((account) => (
                    <SortableAccountRow
                      key={account.id}
                      account={account}
                      editMode={editMode}
                      onEdit={(a) => { setEditing(a); setFormOpen(true); }}
                      onDelete={setDeleteTarget}
                    />
                  ))}
                </div>
              </SortableContext>
            </DndContext>
          </section>
        );
      })}

      {accounts.length === 0 && (
        <div className="space-y-3 rounded-lg border px-6 py-12 text-center">
          <p className="text-sm text-muted-foreground">{t("accounts.empty")}</p>
          <Button size="sm" onClick={() => { setEditing(null); setFormOpen(true); }}>
            <Plus className="mr-1 h-4 w-4" /> {t("accounts.addAccount")}
          </Button>
        </div>
      )}
      </div>

      {/* Desktop-only net-worth summary + liquidity breakdown (uses the horizontal space). */}
      <aside className="hidden lg:block">
        <div className="sticky top-20 rounded-xl border border-border p-5">
          <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">{t("accounts.netWorth")}</p>
          <p className={`mt-1 text-3xl font-bold tabular-nums ${balanceClass(totalNetWorth)}`}>{USD.format(totalNetWorth)}</p>
          {netWorthBreakdown.length > 0 && (
            <dl className="mt-4 space-y-2 border-t border-border pt-4">
              {netWorthBreakdown.map((b) => (
                <div key={b.label} className="flex items-center justify-between text-sm">
                  <dt className="text-muted-foreground">{b.label}</dt>
                  <dd className={`tabular-nums ${balanceClass(b.total) || ""}`}>{USD.format(b.total)}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      </aside>
      </div>

      <AccountForm
        open={formOpen}
        onClose={() => { setFormOpen(false); setEditing(null); }}
        onSave={handleSave}
        initial={editing ?? undefined}
        title={editing ? "Edit Account" : "Add Account"}
        isEdit={!!editing}
        defaultCurrency={baseCurrency}
      />

      {/* Delete confirmation */}
      <Dialog open={!!deleteTarget} onOpenChange={(o) => { if (!o) setDeleteTarget(null); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete account?</DialogTitle>
            <DialogDescription>
              “{deleteTarget?.name}” and its transactions will be permanently deleted. This can’t be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>Cancel</Button>
            <Button className="bg-red-600 text-white hover:bg-red-700" onClick={confirmDelete}>Delete</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageContainer>
  );
}
