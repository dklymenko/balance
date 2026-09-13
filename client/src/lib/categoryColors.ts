// A fixed, accessible categorical palette so each category keeps a consistent
// hue across the donut, the ranked list bars, and legends. Hues are mid-tone so
// they read on both light and dark themes. Assigned by rank (stable per render).

export const CATEGORY_PALETTE = [
  "#E8483D", // coral
  "#F0622E", // orange
  "#F5A623", // amber
  "#E8C20E", // yellow
  "#8BC34A", // yellow-green
  "#3DD17F", // green
  "#1FB5A6", // teal
  "#38BDF8", // sky
  "#3B82F6", // blue
  "#6366F1", // indigo
  "#A855F7", // violet
  "#EC4899", // magenta
];

export const OTHER_COLOR = "#8E8E93"; // muted neutral for the grouped long tail

export function categoryColor(rank: number): string {
  return CATEGORY_PALETTE[rank % CATEGORY_PALETTE.length];
}
