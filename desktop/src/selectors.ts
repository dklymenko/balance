import type { AmazonSelectors } from "./types";

// Bundled defaults -- match the amazon.com order-history layout as of 2026-05.
export const BUNDLED_SELECTORS: AmazonSelectors = {
  ordersContainer: ".order, .order-card, .your-orders-content-container, [class*='order-card']",
  orderCard: ".order, .order-card, [class*='order-card']",
};

// Selectors ship with the app. Updating them therefore follows the same
// reviewed, versioned release path as every other executable behavior.
export function loadSelectors(): AmazonSelectors {
  return BUNDLED_SELECTORS;
}
