// Display rules for a two-level category tree in the spend reports:
//   - sub-categories with no spend are dropped, so a parent whose children
//     are all empty shows as a plain top-level row;
//   - a parent whose spend all sits in ONE sub-category is replaced by that
//     sub-category (no pointless nesting). A parent with spend of its own
//     beside that one child keeps both, nested.
export interface SpendTreeNode<T> {
  id: number | null;
  name: string;
  total: number;
  children: T[];
}

const EPS = 0.005;

export function simplifyCategoryTree<T extends SpendTreeNode<T>>(nodes: T[]): T[] {
  return nodes.map((node) => {
    const children = node.children.filter((c) => c.total > EPS);
    const ownSpend = node.total - children.reduce((s, c) => s + c.total, 0);
    if (children.length === 1 && ownSpend <= EPS) return { ...children[0], children: [] };
    return { ...node, children };
  });
}
