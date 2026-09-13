import { useState, useEffect, useMemo } from "react";
import { Check, ChevronsUpDown } from "lucide-react";
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
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
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
import TagPicker from "@/components/TagPicker";
import { txTypeLabel } from "@/lib/txType";
import { ACCOUNT_GROUPS } from "@/lib/accountGroups";
import { evalExpression, hasOperator } from "@/lib/calc";
import { getRecentCategoryIds, pushRecentCategory } from "@/lib/recentCategories";
import { categoryColor } from "@/lib/categoryColors";

export interface Tag {
  id: number;
  name: string;
}

export interface Account {
  id: number;
  name: string;
  base_currency: string;
  exchange_rate?: number;
  account_type: string;
  liquidity_type: "Liquid" | "Invested" | "Locked";
  is_default?: boolean;
  is_active?: boolean;
}

// Accounts the user can book a new transaction against. Inactive (legacy/closed)
// accounts are excluded -- they only exist to hold imported history.
export function selectableAccounts(accounts: Account[]): Account[] {
  return accounts.filter((a) => a.is_active !== false);
}

// Returns id of the user-marked default account, or first selectable account, or "".
export function findDefaultAccountId(accounts: Account[]): string {
  const selectable = selectableAccounts(accounts);
  const def = selectable.find(a => a.is_default);
  if (def) return String(def.id);
  return selectable[0]?.id ? String(selectable[0].id) : "";
}

export interface Category {
  id: number;
  name: string;
  parent_id: number | null;
  kind?: "income" | "expense" | "both";
}

export interface TransactionPayload {
  account_id: number;
  category_id: number | null;
  date: string;
  description: string;
  amount_fx: number;
  exchange_rate: number;
  amount_usd: number;
  type: "debit" | "credit" | "transfer";
  to_account_id?: number;
  exclude_from_reports?: boolean;
}

export interface InitialTransaction {
  id: number;
  account_id: number;
  category_id: number | null;
  date: string;
  description: string;
  amount_fx: number;
  exchange_rate: number;
  type: "debit" | "credit" | "transfer";
  to_account_id?: number;
  transfer_group_id?: string;
  exclude_from_reports?: boolean;
  tag_ids?: number[];
}

interface Props {
  open: boolean;
  onClose: () => void;
  onSave: (data: TransactionPayload, tagIds: number[]) => Promise<void>;
  accounts: Account[];
  categories: Category[];
  allTags: Tag[];
  onCreateTag?: (name: string) => Promise<Tag | null>;
  defaultAccountId?: number;
  initial?: InitialTransaction;
  title?: string;
  // Preselect the type for a NEW transaction (e.g. from the FAB speed dial).
  defaultType?: "debit" | "credit" | "transfer";
}

// Local (device-time) YYYY-MM-DD, offset by `days`. Uses the browser's timezone
// so "Today" matches the user's calendar, not the server's/UTC date.
function localDateStr(days = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const tzMs = d.getTime() - d.getTimezoneOffset() * 60000;
  return new Date(tzMs).toISOString().slice(0, 10);
}

function AccountSelect({ value, onChange, accounts, placeholder, ariaLabel }: {
  value: string;
  onChange: (v: string) => void;
  accounts: Account[];
  placeholder: string;
  ariaLabel: string;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger aria-label={ariaLabel}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      {/* Accounts listed in a fixed order (Credit, Banking, Invested, Locked) with no
          type headings -- the account name alone is what the user picks. */}
      <SelectContent position="popper" className="max-h-72 overflow-y-auto">
        {ACCOUNT_GROUPS.flatMap(({ filter }) => selectableAccounts(accounts).filter(filter)).map((a) => (
          <SelectItem key={a.id} value={String(a.id)}>{a.name}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export default function TransactionForm({
  open, onClose, onSave, accounts, categories, allTags, onCreateTag, defaultAccountId, initial, title, defaultType,
}: Props) {
  const isEditing = !!initial;

  const [accountId, setAccountId] = useState("");
  const [toAccountId, setToAccountId] = useState("");
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [categoryOpen, setCategoryOpen] = useState(false);
  const [date, setDate] = useState(localDateStr(0));
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [type, setType] = useState<"debit" | "credit" | "transfer">("debit");
  const [exchangeRate, setExchangeRate] = useState("1");
  const [excludeFromReports, setExcludeFromReports] = useState(false);
  const [tagIds, setTagIds] = useState<number[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      if (initial) {
        setAccountId(String(initial.account_id));
        setToAccountId(initial.to_account_id ? String(initial.to_account_id) : "");
        setCategoryId(initial.category_id);
        setDate(initial.date);
        setDescription(initial.description);
        setAmount(String(initial.amount_fx));
        setType(initial.type);
        setExchangeRate(String(initial.exchange_rate));
        setExcludeFromReports(initial.exclude_from_reports ?? false);
        setTagIds(initial.tag_ids ?? []);
      } else {
        setAccountId(defaultAccountId ? String(defaultAccountId) : findDefaultAccountId(accounts));
        setCategoryId(null);
        setDate(localDateStr(0));
        setDescription("");
        setAmount("");
        setType(defaultType ?? "debit");
        setExchangeRate("1");
        setExcludeFromReports(false);
        setTagIds([]);
        setToAccountId("");
      }
      setCategoryOpen(false);
      setSaveError(null);
    }
  }, [open, initial, defaultAccountId, accounts, defaultType]);

  const isTransfer = type === "transfer";
  const selectedAccount = accounts.find((a) => a.id === Number(accountId));
  const isNonUSD = !isTransfer && selectedAccount && selectedAccount.base_currency !== "USD";

  const selectedCategory = categories.find(c => c.id === categoryId);
  const isIncomeCategory = selectedCategory?.kind === "income";

  // Income categories can only be credits -- coerce away from debit automatically.
  useEffect(() => {
    if (isIncomeCategory && type === "debit") setType("credit");
  }, [isIncomeCategory, type]);

  const categoryLabel = selectedCategory
    ? selectedCategory.parent_id
      ? `${categories.find(c => c.id === selectedCategory.parent_id)?.name ?? ""} › ${selectedCategory.name}`
      : selectedCategory.name
    : "Select category…";

  const parentCategories = categories.filter(c => c.parent_id === null);
  const categoryById = useMemo(() => new Map(categories.map(c => [c.id, c])), [categories]);

  // Quick-pick chips: the selected category (if any) first, then recently used
  // categories, padded with top-level categories -- deduped, capped at 6.
  const chipCategories = useMemo(() => {
    const seen = new Set<number>();
    const out: Category[] = [];
    const add = (c?: Category) => {
      if (c && !seen.has(c.id)) { seen.add(c.id); out.push(c); }
    };
    if (selectedCategory) add(selectedCategory);
    for (const id of getRecentCategoryIds()) add(categoryById.get(id));
    for (const p of parentCategories) add(p);
    return out.slice(0, 6);
  }, [selectedCategory, categoryById, parentCategories]);

  const amountValue = evalExpression(amount);
  const amountValid = amountValue !== null && amountValue > 0;

  const canSubmit = !!accountId && amountValid && (
    !isTransfer || (!!toAccountId && toAccountId !== accountId)
  );

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setSaveError(null);
    setSaving(true);
    const amountFx = amountValue ?? 0;
    const rate = isTransfer ? (selectedAccount?.exchange_rate ?? 1) : Number(exchangeRate);
    const finalCategoryId = isTransfer ? null : categoryId;
    try {
      await onSave({
        account_id: Number(accountId),
        category_id: finalCategoryId,
        date,
        description,
        amount_fx: amountFx,
        exchange_rate: rate,
        amount_usd: amountFx * rate,
        type,
        to_account_id: isTransfer ? Number(toAccountId) : undefined,
        exclude_from_reports: isTransfer ? false : excludeFromReports,
      }, tagIds);
      if (finalCategoryId) pushRecentCategory(finalCategoryId);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Couldn't save the transaction. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{title ?? "Add Transaction"}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">

          {/* Amount -- the most important field: shown first and large. Accepts a
              plain number or a chained expression ("27+13-9"), calculated live. */}
          <div className="space-y-1.5">
            <Label htmlFor="amount" className="text-base font-semibold">
              Amount ({selectedAccount?.base_currency ?? "USD"})
            </Label>
            <div className="flex items-center gap-2">
              <Input
                id="amount"
                type="text"
                inputMode="text"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.00 or 27+13-9"
                autoComplete="off"
                required
                className="h-12 flex-1 text-2xl font-semibold tabular-nums"
              />
              {hasOperator(amount) && amountValue !== null && (
                <span className="shrink-0 text-right text-2xl font-semibold text-muted-foreground tabular-nums">
                  = {amountValue.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                </span>
              )}
            </div>
            {isNonUSD && (
              <div className="pt-1">
                <Label htmlFor="rate" className="text-xs text-muted-foreground">Exchange Rate</Label>
                <Input
                  id="rate"
                  type="number"
                  step="0.0001"
                  value={exchangeRate}
                  onChange={(e) => setExchangeRate(e.target.value)}
                  placeholder="1.0"
                />
              </div>
            )}
          </div>

          {/* Category (required) sits above Description (optional). */}
          {!isTransfer && (
            <div className="space-y-1.5">
              <Label>Category</Label>
              {/* Quick-pick chips: selected + recently used + top-level categories,
                  so a repeat purchase is one tap. Full search stays below. */}
              {chipCategories.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {chipCategories.map((c, i) => {
                    const active = categoryId === c.id;
                    return (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => setCategoryId(c.id)}
                        className={cn(
                          "flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm font-medium transition-colors",
                          active ? "border-primary bg-primary text-primary-foreground" : "border-border text-foreground hover:bg-secondary",
                        )}
                      >
                        <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: categoryColor(i) }} />
                        {c.name}
                      </button>
                    );
                  })}
                </div>
              )}
              <Popover open={categoryOpen} onOpenChange={setCategoryOpen}>
                <PopoverTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    role="combobox"
                    aria-label="Category"
                    className="w-full justify-between font-normal"
                  >
                    <span className={cn(!categoryId && "text-muted-foreground")}>{categoryLabel}</span>
                    <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent
                  className="p-0"
                  style={{ width: "var(--radix-popover-trigger-width)" }}
                  align="start"
                >
                  <Command>
                    <CommandInput placeholder="Search categories…" />
                    <CommandList>
                      <CommandEmpty>No category found.</CommandEmpty>
                      {parentCategories.map((parent) => {
                        const children = categories.filter(c => c.parent_id === parent.id);
                        return (
                          <CommandGroup key={parent.id} heading={parent.name}>
                            <CommandItem
                              value={parent.name}
                              onSelect={() => { setCategoryId(parent.id); setCategoryOpen(false); }}
                            >
                              <Check className={cn("mr-2 h-4 w-4", categoryId === parent.id ? "opacity-100" : "opacity-0")} />
                              {parent.name}
                            </CommandItem>
                            {children.map(child => (
                              <CommandItem
                                key={child.id}
                                value={`${parent.name} ${child.name}`}
                                onSelect={() => { setCategoryId(child.id); setCategoryOpen(false); }}
                                className="pl-8"
                              >
                                <Check className={cn("mr-2 h-4 w-4", categoryId === child.id ? "opacity-100" : "opacity-0")} />
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
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="description">Description</Label>
            <Input
              id="description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Merchant or note…"
            />
          </div>

          {/* Labels -- styled to match the other input fields (same border/height). */}
          {!isTransfer && (
            <div className="space-y-1.5">
              <Label>Labels</Label>
              <div className="flex min-h-9 w-full items-center rounded-md border border-input bg-transparent px-3 py-1">
                <TagPicker allTags={allTags} selectedIds={tagIds} onChange={setTagIds} onCreate={onCreateTag} />
              </div>
            </div>
          )}

          <div className="space-y-1.5">
            <Label>{isTransfer ? "From Account" : "Account"}</Label>
            <AccountSelect
              value={accountId}
              onChange={setAccountId}
              accounts={accounts}
              placeholder="Select account"
              ariaLabel={isTransfer ? "From Account" : "Account"}
            />
          </div>

          {isTransfer && (
            <div className="space-y-1.5">
              <Label>To Account</Label>
              <AccountSelect
                value={toAccountId}
                onChange={setToAccountId}
                accounts={accounts}
                placeholder="Select account"
                ariaLabel="To Account"
              />
            </div>
          )}

          <div className="space-y-1.5">
            <Label>Type</Label>
            <Select value={type} onValueChange={(v) => setType(v as typeof type)} disabled={isEditing}>
              <SelectTrigger aria-label="Type"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="debit" disabled={isIncomeCategory}>{txTypeLabel("debit")}</SelectItem>
                <SelectItem value="credit">{txTypeLabel("credit")}</SelectItem>
                <SelectItem value="transfer">{txTypeLabel("transfer")}</SelectItem>
              </SelectContent>
            </Select>
            {isIncomeCategory && (
              <p className="text-xs text-muted-foreground">Income category -- income only.</p>
            )}
          </div>

          {/* Date -- Today / Yesterday quick picks (device time), plus a full picker. */}
          <div className="space-y-1.5">
            <Label htmlFor="date">Date</Label>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => setDate(localDateStr(0))}
                className={cn("h-9 shrink-0 rounded-md border px-2.5 text-xs transition-colors",
                  date === localDateStr(0) ? "border-primary text-primary" : "text-muted-foreground hover:text-foreground")}
              >
                Today
              </button>
              <button
                type="button"
                onClick={() => setDate(localDateStr(-1))}
                className={cn("h-9 shrink-0 rounded-md border px-2.5 text-xs transition-colors",
                  date === localDateStr(-1) ? "border-primary text-primary" : "text-muted-foreground hover:text-foreground")}
              >
                Yesterday
              </button>
              <Input
                id="date"
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                required
                className="min-w-0 flex-1"
              />
            </div>
          </div>

          {/* "Exclude from reports" is an advanced power-user flag -- it is not shown
              on the entry/edit form. Editing preserves whatever value the row already
              had (see excludeFromReports init from `initial`); it's toggled from the
              Transactions list when advanced features are enabled. */}

          {saveError && <p role="alert" className="text-sm text-destructive">{saveError}</p>}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={saving || !canSubmit}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
