export interface ParsedRow {
  date: string;       // YYYY-MM-DD
  amount: string;     // absolute value as string
  description: string;
  type: "debit" | "credit";
}

// Minimal RFC-4180 CSV parser (handles quoted fields with embedded commas/newlines)
function parseCSV(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let field = "";
  let inQuote = false;
  let row: string[] = [];

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (inQuote) {
      if (ch === '"' && next === '"') { field += '"'; i++; }
      else if (ch === '"') { inQuote = false; }
      else { field += ch; }
    } else {
      if (ch === '"') { inQuote = true; }
      else if (ch === ',') { row.push(field.trim()); field = ""; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && next === '\n') i++;
        row.push(field.trim()); field = "";
        if (row.some(f => f !== "")) rows.push(row);
        row = [];
      } else { field += ch; }
    }
  }
  if (field || row.length) { row.push(field.trim()); if (row.some(f => f !== "")) rows.push(row); }

  if (rows.length < 2) return [];
  const headers = rows[0];
  return rows.slice(1).map(r => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ""])));
}

function isRealIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [, y, m, d] = match.map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

function mmddyyyyToISO(raw: string): string | null {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(raw.trim());
  if (!match) return null;
  const [, m, d, y] = match;
  const iso = `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  return isRealIsoDate(iso) ? iso : null;
}

function parseAmount(rawValue: string | undefined): number | null {
  if (typeof rawValue !== "string") return null;
  let value = rawValue.trim().replace(/[$,]/g, "");
  const parenthesized = /^\((.*)\)$/.exec(value);
  if (parenthesized) value = `-${parenthesized[1]}`;
  if (!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(value)) return null;
  const amount = Number(value);
  return Number.isFinite(amount) && amount !== 0 && Math.abs(amount) <= 1e12 ? amount : null;
}

// Format A -- credit card: Transaction Date, Post Date, Description, Category, Type, Amount, Memo
// Format A -- checking:    Details, Posting Date, Description, Amount, Type, Balance, Check or Slip #
export function parseFormatACsv(text: string): ParsedRow[] {
  const records = parseCSV(text);
  if (records.length === 0) return [];

  const isCreditCard = "Transaction Date" in records[0];

  return records.flatMap(r => {
    if (isCreditCard) {
      const raw = parseAmount(r["Amount"]);
      const date = mmddyyyyToISO(r["Transaction Date"]);
      if (raw === null || date === null) return [];
      return [{
        date,
        amount: String(Math.abs(raw)),
        description: r["Description"] ?? "",
        type: raw < 0 ? "debit" : "credit",
      }];
    } else {
      const raw = parseAmount(r["Amount"]);
      const date = mmddyyyyToISO(r["Posting Date"]);
      if (raw === null || date === null) return [];
      const detail = (r["Details"] ?? "").toUpperCase();
      return [{
        date,
        amount: String(Math.abs(raw)),
        description: r["Description"] ?? "",
        type: detail === "CREDIT" ? "credit" : "debit",
      }];
    }
  });
}

// Format B: Date (YYYY-MM-DD), Transaction (DEBIT/CREDIT), Name, Memo, Amount
export function parseFormatBCsv(text: string): ParsedRow[] {
  const records = parseCSV(text);
  return records.flatMap(r => {
    const raw = parseAmount(r["Amount"]);
    if (raw === null || !isRealIsoDate(r["Date"])) return [];
    return [{
      date: r["Date"],
      amount: String(Math.abs(raw)),
      description: (r["Name"] ?? "").replace(/\s+/g, " ").trim(),
      type: r["Transaction"]?.toUpperCase() === "CREDIT" ? "credit" : "debit",
    }];
  });
}
