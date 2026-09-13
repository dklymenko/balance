export interface SpendRow {
  category_id: number | null;
  category_name: string | null;
  parent_id: number | null;
  total_usd: number;
}

export interface ReportCategory {
  id: number;
  name: string;
  parent_id: number | null;
}

export interface CategoryNode {
  id: number | null;
  name: string;
  parent_id: number | null;
  total: number;
  children: CategoryNode[];
}

export function buildCategoryTree(rows: SpendRow[], allCats: ReportCategory[]): CategoryNode[] {
  const byId = new Map<number | null, CategoryNode>();

  for (const cat of allCats) {
    byId.set(cat.id, { id: cat.id, name: cat.name, parent_id: cat.parent_id, total: 0, children: [] });
  }
  byId.set(null, { id: null, name: "Uncategorized", parent_id: null, total: 0, children: [] });

  for (const row of rows) {
    const node = byId.get(row.category_id ?? null);
    if (node) node.total += row.total_usd;
  }

  const roots: CategoryNode[] = [];
  for (const node of byId.values()) {
    if (node.parent_id === null) {
      roots.push(node);
    } else {
      const parent = byId.get(node.parent_id);
      if (parent) parent.children.push(node);
      else roots.push(node);
    }
  }

  const rollUp = (node: CategoryNode): number => {
    node.total += node.children.reduce((sum, child) => sum + rollUp(child), 0);
    node.children = node.children.filter((child) => child.total > 0);
    return node.total;
  };
  for (const root of roots) rollUp(root);

  roots.sort((a, b) => b.total - a.total);
  for (const node of roots) node.children.sort((a, b) => b.total - a.total);
  return roots.filter((node) => node.total > 0);
}

export function reportMonths(start: string, end: string): string[] {
  const [startYear, startMonth] = start.split("-").map(Number);
  const [endYear, endMonth] = end.split("-").map(Number);
  const count = Math.max(1, (endYear - startYear) * 12 + (endMonth - startMonth) + 1);
  const months: string[] = [];
  for (let offset = count - 1; offset >= 0; offset--) {
    const date = new Date(endYear, endMonth - 1 - offset, 1);
    months.push(`${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`);
  }
  return months;
}

export function netIncomeTrend(firstNet: number, latestNet: number): {
  direction: "up" | "down";
  message: string;
} {
  if (latestNet >= firstNet) {
    return { direction: "up", message: "Net income is trending up" };
  }
  if (latestNet >= 0) {
    return { direction: "down", message: "Net income is positive, but trending down" };
  }
  return { direction: "down", message: "Spending is currently higher than income" };
}
