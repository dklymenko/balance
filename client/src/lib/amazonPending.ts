// Parser for pending-charge text pasted from a bank's website.
//
// The bank groups charges by day with a header date ("Jan 5, 2026") and repeats
// each row's date in numeric form ("01/05/2026"). Merchant/description lines and
// the column headers ("Date", "Description", "Amount", "Action") sit in between.
// We only care about (date, amount): walk the lines, remember the most recent
// date seen, and emit a charge whenever an amount line appears.

export interface PendingCharge {
  date: string;   // YYYY-MM-DD
  amount: number; // positive dollars
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

function pad(n: number | string): string {
  return String(n).padStart(2, "0");
}

function realIsoDate(year: number, month: number, day: number): string | null {
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) return null;
  return `${year}-${pad(month)}-${pad(day)}`;
}

function parseDate(line: string): string | null {
  // "Jan 5, 2026" / "January 5 2026"
  let m = line.match(/^([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})$/);
  if (m) {
    const month = MONTHS[m[1].slice(0, 3).toLowerCase()];
    if (month) return realIsoDate(Number(m[3]), month, Number(m[2]));
  }
  // "01/05/2026" / "1/5/2026"
  m = line.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return realIsoDate(Number(m[3]), Number(m[1]), Number(m[2]));
  return null;
}

function parseAmount(line: string): number | null {
  const m = line.match(/^\$\s*([\d,]+\.\d{2})$/);
  if (!m) return null;
  const amount = Number(m[1].replace(/,/g, ""));
  return Number.isFinite(amount) && amount > 0 && amount <= 1e12 ? amount : null;
}

export function parsePendingAmazonText(text: string): PendingCharge[] {
  const out: PendingCharge[] = [];
  let currentDate: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const date = parseDate(line);
    if (date) { currentDate = date; continue; }
    const amount = parseAmount(line);
    if (amount != null && currentDate) out.push({ date: currentDate, amount });
  }
  return out;
}
