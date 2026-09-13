// User-facing labels for transaction types. The DB/enum keeps debit/credit, but
// every surface the user sees (forms, filters, badges, search) reads
// "Expense" / "Income" / "Transfer".
export type TxType = "debit" | "credit" | "transfer";

export function txTypeLabel(type: string): string {
  switch (type) {
    case "debit": return "Expense";
    case "credit": return "Income";
    case "transfer": return "Transfer";
    default: return type;
  }
}
