// Small visual helpers for list rows: a monogram (initials in a colored circle)
// used as the leading avatar on mobile transaction rows, and human date-group
// labels ("Today" / "Yesterday" / "12 Jun 2025") for date headers.

// Up to two uppercase initials from a label: two words → first letter of each
// ("Food Dining" → "FD"); one word → its first two letters ("Groceries" → "GR").
export function monogram(label: string | null | undefined): string {
  const s = (label ?? "").trim();
  if (!s) return "?";
  const words = s.split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return s.slice(0, 2).toUpperCase();
}

// Stable, theme-friendly background/text pair for a monogram, chosen by hashing
// the label so the same category always gets the same color.
const MONOGRAM_COLORS = [
  "bg-blue-100 text-blue-700",
  "bg-green-100 text-green-700",
  "bg-purple-100 text-purple-700",
  "bg-orange-100 text-orange-700",
  "bg-pink-100 text-pink-700",
  "bg-teal-100 text-teal-700",
  "bg-amber-100 text-amber-700",
  "bg-rose-100 text-rose-700",
  "bg-indigo-100 text-indigo-700",
  "bg-cyan-100 text-cyan-700",
];

export function monogramColor(label: string | null | undefined): string {
  const s = (label ?? "").trim() || "?";
  let hash = 0;
  for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) | 0;
  return MONOGRAM_COLORS[Math.abs(hash) % MONOGRAM_COLORS.length];
}

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

// Local YYYY-MM-DD for `now`, so "Today"/"Yesterday" match the device calendar.
function localYmd(d: Date): string {
  const tz = d.getTime() - d.getTimezoneOffset() * 60000;
  return new Date(tz).toISOString().slice(0, 10);
}

// "Today" / "Yesterday" for the two most recent days, else "12 Jun 2025".
export function dateGroupLabel(iso: string, now: Date = new Date()): string {
  const today = localYmd(now);
  const yesterday = localYmd(new Date(now.getTime() - 24 * 60 * 60 * 1000));
  if (iso === today) return "Today";
  if (iso === yesterday) return "Yesterday";
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  return `${String(d).padStart(2, "0")} ${MONTHS[m - 1]} ${y}`;
}
