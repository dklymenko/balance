import { useEffect, useState } from "react";
import { AlertTriangle, Check, ChevronDown, ChevronRight, ChevronsUpDown, X } from "lucide-react";
import type { DupeWarning } from "@/lib/dedupe";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { findDefaultAccountId, type Account, type Category } from "./TransactionForm";
import { txTypeLabel } from "@/lib/txType";
import TagPicker from "./TagPicker";
import { ACCOUNT_GROUPS } from "@/lib/accountGroups";

interface Tag {
  id: number;
  name: string;
}

interface BulkRow {
  id: string;
  date: string;
  amount: string;
  description: string;
  category_id: number | null;
  account_id: string;
  type: "debit" | "credit";
  tag_ids: number[];
  dupe_warning: DupeWarning | null;
  // Full Amazon item list from a match -- shown on demand, never saved to the DB.
  amazon_items?: string[];
}

export interface InitialBulkRow {
  date?: string;
  amount?: string;
  description?: string;
  category_id?: number | null;
  account_id?: string;
  type?: "debit" | "credit";
  tag_ids?: number[];
  dupe_warning?: DupeWarning | null;
}

export interface BulkTransactionPayload {
  account_id: number;
  category_id: number | null;
  date: string;
  description: string;
  amount_fx: number;
  exchange_rate: number;
  amount_usd: number;
  type: "debit" | "credit";
  tag_ids: number[];
}

interface Props {
  open: boolean;
  onClose: () => void;
  onSave: (rows: BulkTransactionPayload[]) => Promise<void>;
  accounts: Account[];
  categories: Category[];
  allTags: Tag[];
  onCreateTag?: (name: string) => Promise<Tag | null>;
  defaultAccountId?: number;
  initialRows?: InitialBulkRow[];
}


function makeRow(date: string, accountId: string): BulkRow {
  return { id: crypto.randomUUID(), date, amount: "", description: "", category_id: null, account_id: accountId, type: "debit", tag_ids: [], dupe_warning: null };
}

function rowHasData(r: BulkRow): boolean {
  return !!(r.amount || r.description || r.category_id);
}

function trailingEmptyCount(rows: BulkRow[]): number {
  let count = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (!rowHasData(rows[i])) count++;
    else break;
  }
  return count;
}

function CategoryCell({ categories, value, onChange }: {
  categories: Category[];
  value: number | null;
  onChange: (id: number | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const parents = categories.filter(c => c.parent_id === null);
  const selected = categories.find(c => c.id === value);
  const label = selected
    ? selected.parent_id
      ? `${categories.find(c => c.id === selected.parent_id)?.name ?? ""} › ${selected.name}`
      : selected.name
    : "";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" role="combobox" aria-label="Transaction category"
          className="h-8 w-56 justify-between font-normal text-sm px-2">
          <span className={cn("truncate", !value && "text-muted-foreground")}>
            {label || "Category…"}
          </span>
          <ChevronsUpDown className="ml-1 h-3.5 w-3.5 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="p-0 w-64" align="start">
        <Command>
          <CommandInput placeholder="Search…" />
          <CommandList className="max-h-56 overflow-y-auto">
            <CommandEmpty>No category found.</CommandEmpty>
            <CommandItem value="none" onSelect={() => { onChange(null); setOpen(false); }}>
              <Check className={cn("mr-2 h-4 w-4", value === null ? "opacity-100" : "opacity-0")} />
              <span className="text-muted-foreground">None</span>
            </CommandItem>
            {parents.map(parent => {
              const children = categories.filter(c => c.parent_id === parent.id);
              return (
                <CommandGroup key={parent.id} heading={parent.name}>
                  <CommandItem value={parent.name} onSelect={() => { onChange(parent.id); setOpen(false); }}>
                    <Check className={cn("mr-2 h-4 w-4", value === parent.id ? "opacity-100" : "opacity-0")} />
                    {parent.name}
                  </CommandItem>
                  {children.map(child => (
                    <CommandItem key={child.id} value={`${parent.name} ${child.name}`}
                      onSelect={() => { onChange(child.id); setOpen(false); }} className="pl-8">
                      <Check className={cn("mr-2 h-4 w-4", value === child.id ? "opacity-100" : "opacity-0")} />
                      {child.name}
                    </CommandItem>
                  ))}
                </CommandGroup>
              );
            })}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export default function MultiTransactionForm({
  open, onClose, onSave, accounts, categories, allTags, onCreateTag, defaultAccountId, initialRows,
}: Props) {
  const today = new Date().toISOString().slice(0, 10);

  function resolvedDefaultAccId() {
    return defaultAccountId ? String(defaultAccountId) : findDefaultAccountId(accounts);
  }

  const [rows, setRows] = useState<BulkRow[]>(() =>
    Array.from({ length: 5 }, () => makeRow(today, resolvedDefaultAccId()))
  );
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setSaveError(null);
    const defAccId = resolvedDefaultAccId();
    if (initialRows && initialRows.length > 0) {
      const filled: BulkRow[] = initialRows.map(r => ({
        ...makeRow(r.date ?? today, r.account_id ?? defAccId),
        ...r,
        id: crypto.randomUUID(),
        tag_ids: r.tag_ids ?? [],
        category_id: r.category_id ?? null,
        description: r.description ?? "",
        amount: r.amount ?? "",
        type: r.type ?? "debit",
        dupe_warning: r.dupe_warning ?? null,
      }));
      while (trailingEmptyCount(filled) < 2) filled.push(makeRow(today, defAccId));
      setRows(filled);
    } else {
      setRows(Array.from({ length: 5 }, () => makeRow(today, defAccId)));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const isIncomeCategory = (catId: number | null) =>
    catId != null && categories.find(c => c.id === catId)?.kind === "income";

  function updateRow(id: string, patch: Partial<BulkRow>) {
    setRows(prev => {
      const next = prev.map(r => {
        if (r.id !== id) return r;
        const merged = { ...r, ...patch };
        // Income categories can only be credits -- coerce away from debit.
        if (isIncomeCategory(merged.category_id) && merged.type === "debit") merged.type = "credit";
        return merged;
      });
      while (trailingEmptyCount(next) < 2) next.push(makeRow(today, resolvedDefaultAccId()));
      return next;
    });
  }

  function removeRow(id: string) {
    setRows(prev => prev.length > 2 ? prev.filter(r => r.id !== id) : prev);
  }

  const validRows = rows.filter(r =>
    r.account_id && r.amount && !isNaN(Number(r.amount)) && Number(r.amount) > 0 && r.date
  );

  const [expandedItems, setExpandedItems] = useState<Set<string>>(new Set());

  function toggleItems(id: string) {
    setExpandedItems(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }


  async function handleSubmit() {
    setSaveError(null);
    setSaving(true);
    try {
      await onSave(validRows.map(r => {
        const rate = accounts.find((account) => account.id === Number(r.account_id))?.exchange_rate ?? 1;
        return {
          account_id: Number(r.account_id),
          category_id: r.category_id,
          date: r.date,
          description: r.description,
          amount_fx: Number(r.amount),
          exchange_rate: rate,
          amount_usd: Number(r.amount) * rate,
          type: r.type,
          tag_ids: r.tag_ids,
        };
      }));
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Couldn't save the transactions. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={v => !v && onClose()}>
      <DialogContent className="max-w-[95vw] w-full sm:max-w-[95vw]">
        <DialogHeader>
          <DialogTitle>Add Multiple Transactions</DialogTitle>
        </DialogHeader>

        <div className="overflow-auto max-h-[65vh]">
          <table className="w-full text-sm border-collapse">
            <thead className="sticky top-0 bg-background z-10">
              <tr className="border-b">
                <th className="text-left py-2 pr-2 font-medium text-muted-foreground whitespace-nowrap">Date</th>
                <th className="text-left py-2 pr-2 font-medium text-muted-foreground whitespace-nowrap">Amount</th>
                <th className="text-left py-2 pr-2 font-medium text-muted-foreground whitespace-nowrap">Category</th>
                <th className="text-left py-2 pr-2 font-medium text-muted-foreground w-full">Description</th>
                <th className="text-left py-2 pr-2 font-medium text-muted-foreground whitespace-nowrap">Account</th>
                <th className="text-left py-2 pr-2 font-medium text-muted-foreground whitespace-nowrap">Type</th>
                <th className="text-left py-2 pr-2 font-medium text-muted-foreground whitespace-nowrap">Labels</th>
                <th className="w-6" />
              </tr>
            </thead>
            <tbody>
              {rows.map(row => (
                <tr key={row.id} className="border-b last:border-0 group">
                  <td className="py-1 pr-2 align-top">
                    <Input aria-label="Transaction date" type="date" value={row.date}
                      onChange={e => updateRow(row.id, { date: e.target.value })}
                      className="h-8 text-sm w-36" />
                  </td>
                  <td className="py-1 pr-2 align-top">
                    <Input aria-label="Transaction amount" type="number" step="0.01" min="0.01" placeholder="0.00" value={row.amount}
                      onChange={e => updateRow(row.id, { amount: e.target.value })}
                      className="h-8 text-sm w-28" />
                  </td>
                  <td className="py-1 pr-2 align-top">
                    <CategoryCell categories={categories} value={row.category_id}
                      onChange={id => updateRow(row.id, { category_id: id })} />
                  </td>
                  <td className="py-1 pr-2 align-top">
                    <div className="flex items-center gap-1">
                      <Input aria-label="Transaction description" placeholder="Description" value={row.description}
                        onChange={e => updateRow(row.id, { description: e.target.value })}
                        className="h-8 text-sm" />
                      {row.amazon_items && row.amazon_items.length > 0 && (
                        <button type="button" onClick={() => toggleItems(row.id)}
                          aria-label={expandedItems.has(row.id) ? "Hide Amazon items" : "Show Amazon items"}
                          className="shrink-0 text-muted-foreground hover:text-foreground"
                          title={expandedItems.has(row.id) ? "Hide Amazon items" : "Show Amazon items"}>
                          {expandedItems.has(row.id)
                            ? <ChevronDown className="w-4 h-4" />
                            : <ChevronRight className="w-4 h-4" />}
                        </button>
                      )}
                    </div>
                    {row.amazon_items && row.amazon_items.length > 0 && expandedItems.has(row.id) && (
                      <ul className="mt-1 text-xs text-muted-foreground list-disc pl-4 leading-tight space-y-0.5">
                        {row.amazon_items.map((it, idx) => <li key={idx}>{it}</li>)}
                      </ul>
                    )}
                    {row.dupe_warning && (
                      <div className="flex items-start gap-1 mt-1 text-xs text-red-600 leading-tight">
                        <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" />
                        <span>
                          Possible duplicate of ${row.dupe_warning.match_amount_usd.toFixed(2)} on {row.dupe_warning.match_account_name ?? "?"} ({row.dupe_warning.match_date}){row.dupe_warning.match_description ? ` -- ${row.dupe_warning.match_description}` : ""}
                        </span>
                      </div>
                    )}
                  </td>
                  <td className="py-1 pr-2 align-top">
                    <Select value={row.account_id} onValueChange={v => updateRow(row.id, { account_id: v })}>
                      <SelectTrigger aria-label="Transaction account" className="h-8 text-sm w-40">
                        <SelectValue placeholder="Account" />
                      </SelectTrigger>
                      <SelectContent className="max-h-72 overflow-y-auto">
                        {ACCOUNT_GROUPS.map(({ key, label, filter }) => {
                          const group = accounts.filter(filter);
                          if (group.length === 0) return null;
                          return (
                            <SelectGroup key={key}>
                              <SelectLabel>{label}</SelectLabel>
                              {group.map(a => (
                                <SelectItem key={a.id} value={String(a.id)}>{a.name}</SelectItem>
                              ))}
                            </SelectGroup>
                          );
                        })}
                      </SelectContent>
                    </Select>
                  </td>
                  <td className="py-1 pr-2 align-top">
                    <Select value={row.type} onValueChange={v => updateRow(row.id, { type: v as "debit" | "credit" })}>
                      <SelectTrigger aria-label="Transaction type" className="h-8 text-sm w-24">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="debit" disabled={isIncomeCategory(row.category_id)}>{txTypeLabel("debit")}</SelectItem>
                        <SelectItem value="credit">{txTypeLabel("credit")}</SelectItem>
                      </SelectContent>
                    </Select>
                  </td>
                  <td className="py-1 pr-2 min-w-[120px] align-top">
                    <TagPicker allTags={allTags} selectedIds={row.tag_ids}
                      onChange={ids => updateRow(row.id, { tag_ids: ids })} onCreate={onCreateTag} />
                  </td>
                  <td className="py-1 align-top">
                    <button type="button" onClick={() => removeRow(row.id)} aria-label="Remove transaction row"
                      className="text-muted-foreground hover:text-destructive opacity-70 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity h-8 flex items-center"
                      disabled={rows.length <= 2}>
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {saveError && <p role="alert" className="text-sm text-destructive">{saveError}</p>}

        <DialogFooter className="sm:justify-end">
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose}>Cancel</Button>
            <Button onClick={handleSubmit} disabled={saving || validRows.length === 0}>
              {saving ? "Saving…" : `Save ${validRows.length} transaction${validRows.length !== 1 ? "s" : ""}`}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
