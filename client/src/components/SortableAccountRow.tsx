import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { AlertTriangle, GripVertical, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { balanceClass } from "@/lib/money";
import { showTypeBadge } from "@/lib/accountTypeLabels";
import { useT } from "@/lib/i18n";

type AccountType =
  | "Cash" | "Checking" | "Savings" | "CC" | "Investment"
  | "Roth401k" | "401k" | "HSA" | "Asset-NonLiquid" | "RSU";

export interface Account {
  id: number;
  name: string;
  account_type: AccountType;
  base_currency: string;
  liquidity_type: "Liquid" | "Invested" | "Locked";
  balance: number;
  exchange_rate: number;
  balance_usd: number;
  ticker: string | null;
  shares_quantity: number | null;
  current_price_usd: number | null;
  market_value: number | null;
  sort_order: number | null;
  notes: string | null;
  is_default?: boolean;
  is_active?: boolean;
  exclude_from_reports?: boolean;
  has_recent_adjustment?: boolean;
}

const USD = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
});

function formatNative(amount: number, currency: string) {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

export function effectiveValue(account: Account): number {
  if (account.account_type === "RSU" && account.market_value != null) {
    return account.market_value;
  }
  return account.balance_usd;
}

interface Props {
  account: Account;
  editMode?: boolean;
  onEdit: (account: Account) => void;
  onDelete: (account: Account) => void;
}

export default function SortableAccountRow({ account, editMode = false, onEdit, onDelete }: Props) {
  const t = useT();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: account.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="flex items-center gap-2"
    >
      {/* Drag handle -- edit mode only */}
      {editMode && (
        <button
          {...attributes}
          {...listeners}
          aria-label="Reorder"
          className="shrink-0 cursor-grab active:cursor-grabbing touch-none text-muted-foreground"
          tabIndex={-1}
        >
          <GripVertical className="h-5 w-5" />
        </button>
      )}

      {/* Tap the row to edit; spans the full width */}
      <button
        type="button"
        onClick={() => onEdit(account)}
        className="flex min-w-0 flex-1 items-center justify-between gap-3 py-3 text-left"
      >
        <div className="min-w-0 space-y-1">
          <p className={`truncate text-[15px] font-medium leading-none ${account.is_active === false ? "text-muted-foreground" : ""}`}>
            {account.name}
          </p>
          <div className="flex flex-wrap items-center gap-1.5">
            {/* Only show the type badge where it adds info the group heading doesn't
                already give (invested/locked sub-types); render it human-readable. */}
            {showTypeBadge(account.account_type) && (
              <Badge variant="outline" className="text-xs">{t(`accountType.${account.account_type}`)}</Badge>
            )}
            {account.is_active === false && (
              <Badge variant="secondary" className="text-xs">Inactive</Badge>
            )}
            {account.ticker && (
              <Badge variant="secondary" className="text-xs">{account.ticker}</Badge>
            )}
            {account.has_recent_adjustment && (
              <Badge variant="destructive" className="text-xs gap-1">
                <AlertTriangle className="w-3 h-3" /> Manual adj.
              </Badge>
            )}
          </div>
        </div>

        <div className="shrink-0 text-right">
          <p className={`text-[15px] font-semibold tabular-nums ${balanceClass(effectiveValue(account))}`}>
            {account.account_type === "RSU"
              ? USD.format(effectiveValue(account))
              : formatNative(account.balance, account.base_currency)}
          </p>
          {account.base_currency !== "USD" && account.account_type !== "RSU" && (
            <p className="text-xs text-muted-foreground">≈ {USD.format(account.balance_usd)}</p>
          )}
          {account.account_type === "RSU" && account.shares_quantity != null && (
            <p className="text-xs text-muted-foreground">
              {account.shares_quantity.toFixed(2)} sh @ {USD.format(account.current_price_usd ?? 0)}
            </p>
          )}
        </div>
      </button>

      {/* Delete -- edit mode only */}
      {editMode && (
        <button
          type="button"
          onClick={() => onDelete(account)}
          aria-label={`Delete ${account.name}`}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-red-500 hover:bg-red-500/10"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}
