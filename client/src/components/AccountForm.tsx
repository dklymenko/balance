import { useState, useEffect } from "react";
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
import { CURRENCIES } from "@/lib/currencies";
import { useT } from "@/lib/i18n";

type AccountType =
  | "Cash" | "Checking" | "Savings" | "CC" | "Investment"
  | "Roth401k" | "401k" | "HSA" | "Asset-NonLiquid" | "RSU";

type LiquidityType = "Liquid" | "Invested" | "Locked";

export interface AccountPayload {
  name: string;
  account_type: AccountType;
  liquidity_type: LiquidityType;
  base_currency: string;
  balance: number;
  exchange_rate: number;
  balance_usd: number;
  ticker: string | null;
  shares_quantity: number | null;
  current_price_usd: number | null;
  notes: string | null;
  is_default?: boolean;
  is_active?: boolean;
  exclude_from_reports?: boolean;
  reason?: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  onSave: (data: AccountPayload) => Promise<void>;
  initial?: Partial<AccountPayload>;
  title: string;
  isEdit?: boolean;
  // Currency preselected for a NEW account (the household base currency).
  defaultCurrency?: string;
}

const DEFAULT_LIQUIDITY: Record<AccountType, LiquidityType> = {
  Cash: "Liquid",
  Checking: "Liquid",
  Savings: "Liquid",
  CC: "Liquid",
  Investment: "Invested",
  Roth401k: "Invested",
  "401k": "Invested",
  HSA: "Invested",
  RSU: "Invested",
  "Asset-NonLiquid": "Locked",
};

const ACCOUNT_TYPES: AccountType[] = [
  "Cash", "Checking", "Savings", "CC", "Investment",
  "Roth401k", "401k", "HSA", "Asset-NonLiquid", "RSU",
];

const LIQUIDITY_TYPES: LiquidityType[] = ["Liquid", "Invested", "Locked"];

export default function AccountForm({ open, onClose, onSave, initial, title, isEdit, defaultCurrency = "USD" }: Props) {
  const tr = useT();
  const [name, setName] = useState("");
  const [accountType, setAccountType] = useState<AccountType>("Checking");
  const [liquidityType, setLiquidityType] = useState<LiquidityType>("Liquid");
  const [currency, setCurrency] = useState("USD");
  const [balance, setBalance] = useState("");
  const [exchangeRate, setExchangeRate] = useState("1");
  const [ticker, setTicker] = useState("");
  const [shares, setShares] = useState("");
  const [price, setPrice] = useState("");
  const [notes, setNotes] = useState("");
  const [isDefault, setIsDefault] = useState(false);
  const [isActive, setIsActive] = useState(true);
  const [excludeFromReports, setExcludeFromReports] = useState(false);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setName(initial?.name ?? "");
      setAccountType(initial?.account_type ?? "Checking");
      setLiquidityType(initial?.liquidity_type ?? "Liquid");
      setCurrency(initial?.base_currency ?? defaultCurrency);
      setBalance(initial?.balance != null ? String(initial.balance) : "");
      setExchangeRate(initial?.exchange_rate != null ? String(initial.exchange_rate) : "1");
      setTicker(initial?.ticker ?? "");
      setShares(initial?.shares_quantity != null ? String(initial.shares_quantity) : "");
      setPrice(initial?.current_price_usd != null ? String(initial.current_price_usd) : "");
      setNotes(initial?.notes ?? "");
      setIsDefault(initial?.is_default ?? false);
      setIsActive(initial?.is_active ?? true);
      setExcludeFromReports(initial?.exclude_from_reports ?? false);
      setReason("");
      setSaveError(null);
    }
  }, [open, initial, defaultCurrency]);

  function handleTypeChange(type: AccountType) {
    setAccountType(type);
    setLiquidityType(DEFAULT_LIQUIDITY[type]);
  }

  const isRSU = accountType === "RSU";
  const isNonUSD = currency !== "USD" && !isRSU;
  const nativeBalance = Number(balance) || 0;
  const balanceChanged = isEdit && initial?.balance != null && nativeBalance !== initial.balance;
  const needsReason = balanceChanged && !isRSU;
  const rate = Number(exchangeRate) || 1;
  const usdEquivalent = isNonUSD ? nativeBalance * rate : nativeBalance;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaveError(null);
    setSaving(true);
    try {
      await onSave({
        name,
        account_type: accountType,
        liquidity_type: liquidityType,
        base_currency: currency,
        balance: isRSU ? 0 : nativeBalance,
        exchange_rate: isRSU ? 1 : rate,
        balance_usd: isRSU ? 0 : usdEquivalent,
        ticker: isRSU ? ticker || null : null,
        shares_quantity: isRSU ? (shares ? Number(shares) : null) : null,
        current_price_usd: isRSU ? (price ? Number(price) : null) : null,
        notes: notes || null,
        is_default: isDefault,
        is_active: isActive,
        exclude_from_reports: excludeFromReports,
        ...(needsReason && { reason }),
      });
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Couldn't save the account. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="name">Name</Label>
            <Input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Wallet EUR"
              required
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Type</Label>
              <Select value={accountType} onValueChange={(v) => handleTypeChange(v as AccountType)}>
                <SelectTrigger aria-label="Type"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {ACCOUNT_TYPES.map((at) => (
                    <SelectItem key={at} value={at}>{tr(`accountType.${at}`)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label>Liquidity</Label>
              <Select value={liquidityType} onValueChange={(v) => setLiquidityType(v as LiquidityType)}>
                <SelectTrigger aria-label="Liquidity"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {LIQUIDITY_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>{t}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {!isRSU && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="balance">Balance ({currency})</Label>
                  <Input
                    id="balance"
                    type="number"
                    step="0.01"
                    value={balance}
                    onChange={(e) => setBalance(e.target.value)}
                    placeholder="0.00"
                    required
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="currency">Currency</Label>
                  <select
                    id="currency"
                    value={currency}
                    onChange={(e) => setCurrency(e.target.value)}
                    className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    {/* Keep any legacy currency the account already uses, even if not in the list. */}
                    {!CURRENCIES.includes(currency as (typeof CURRENCIES)[number]) && currency && (
                      <option value={currency}>{currency}</option>
                    )}
                    {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
              </div>

              {isNonUSD && (
                <div className="space-y-1.5">
                  <Label htmlFor="rate">
                    Exchange Rate ({currency} → USD)
                  </Label>
                  <div className="flex items-center gap-2">
                    <Input
                      id="rate"
                      type="number"
                      step="0.0001"
                      min="0"
                      value={exchangeRate}
                      onChange={(e) => setExchangeRate(e.target.value)}
                      placeholder="1.0"
                      className="max-w-36"
                    />
                    {nativeBalance > 0 && (
                      <span className="text-sm text-muted-foreground">
                        ≈ ${usdEquivalent.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USD
                      </span>
                    )}
                  </div>
                </div>
              )}
            </>
          )}

          {isRSU && (
            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="ticker">Ticker</Label>
                <Input
                  id="ticker"
                  value={ticker}
                  onChange={(e) => setTicker(e.target.value.toUpperCase())}
                  placeholder="META"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="shares">Shares</Label>
                <Input
                  id="shares"
                  type="number"
                  step="0.001"
                  value={shares}
                  onChange={(e) => setShares(e.target.value)}
                  placeholder="0"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="price">Price $</Label>
                <Input
                  id="price"
                  type="number"
                  step="0.01"
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                  placeholder="0.00"
                />
              </div>
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="notes">Notes (optional)</Label>
            <Input
              id="notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Any notes…"
            />
          </div>

          <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
            <input
              type="checkbox"
              checked={isDefault}
              onChange={(e) => setIsDefault(e.target.checked)}
              className="h-4 w-4 rounded border"
            />
            Use as default account for new transactions and CSV imports
          </label>

          {/* Presented as "Inactive" (checked = hidden). Stored as the inverse
              `is_active` column, so no schema change is needed. */}
          <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
            <input
              type="checkbox"
              checked={!isActive}
              onChange={(e) => setIsActive(!e.target.checked)}
              className="h-4 w-4 rounded border"
            />
            Inactive (hides the account from the Accounts list and new-transaction picker)
          </label>

          <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
            <input
              type="checkbox"
              checked={excludeFromReports}
              onChange={(e) => setExcludeFromReports(e.target.checked)}
              className="h-4 w-4 rounded border"
            />
            Exclude from reports (its transactions are left out of spend and income totals)
          </label>

          {needsReason && (
            <div className="space-y-1.5">
              <Label htmlFor="reason">Reason for balance change <span className="text-red-500">*</span></Label>
              <Input
                id="reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. Reconciliation with bank statement"
                required
              />
            </div>
          )}

          {saveError && <p role="alert" className="text-sm text-destructive">{saveError}</p>}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
