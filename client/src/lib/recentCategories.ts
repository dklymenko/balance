// Remembers the categories most recently used in the transaction form, so the
// quick-pick chip row can surface them first for fast repeat entry.
// Stored per browser in localStorage as an ordered list of category ids,
// most-recent first. Purely a UI convenience -- safe to lose.

const STORAGE_KEY = "balance-recent-categories";
const MAX = 12;

export function getRecentCategoryIds(): number[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((n): n is number => typeof n === "number");
  } catch {
    return [];
  }
}

export function pushRecentCategory(id: number): void {
  try {
    const next = [id, ...getRecentCategoryIds().filter((x) => x !== id)].slice(0, MAX);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Ignore storage failures -- recents are best-effort.
  }
}
