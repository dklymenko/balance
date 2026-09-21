import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { Account } from "@/components/SortableAccountRow";

export interface BalanceCorrectionPayload {
  balance: number;
  reason: string;
  date: string;
}

interface Props {
  account: Account | null;
  onClose: () => void;
  onSave: (data: BalanceCorrectionPayload) => Promise<void>;
}

export default function BalanceCorrectionDialog({ account, onClose, onSave }: Props) {
  const [balance, setBalance] = useState("");
  const [reason, setReason] = useState("");
  const [date, setDate] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!account) return;
    setBalance(String(account.balance));
    setReason("");
    setDate(new Date().toISOString().slice(0, 10));
    setError(null);
  }, [account]);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    const target = Number(balance);
    if (!Number.isFinite(target)) {
      setError("Enter a valid balance.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave({ balance: target, reason: reason.trim(), date });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't correct the balance.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={!!account} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Correct balance</DialogTitle>
          <DialogDescription>
            This creates a Correction transaction and keeps the account history intact. It is excluded from spending and income reports.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label>Account</Label>
            <p className="text-sm font-medium">{account?.name}</p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="current-balance">Current balance</Label>
              <Input id="current-balance" value={account?.balance ?? ""} readOnly aria-readonly="true" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="corrected-balance">Correct balance ({account?.base_currency})</Label>
              <Input id="corrected-balance" type="number" step="0.01" value={balance} onChange={(event) => setBalance(event.target.value)} required autoFocus />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="correction-date">Date</Label>
            <Input id="correction-date" type="date" value={date} onChange={(event) => setDate(event.target.value)} required />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="correction-reason">Reason</Label>
            <Input id="correction-reason" value={reason} onChange={(event) => setReason(event.target.value)} placeholder="e.g. Reconciled with bank statement" required maxLength={10000} />
          </div>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={saving}>{saving ? "Saving…" : "Save correction"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
