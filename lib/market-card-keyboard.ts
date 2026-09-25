/**
 * Keyboard navigation helpers for market card grids.
 *
 * Contract-first / privacy-safe: only navigation metadata (ids, states) is
 * considered — never wallet addresses, prompts, or analytics payloads.
 */

export const MARKET_CARD_ATTR = "data-market-card";
export const MARKET_CARD_STATE_ATTR = "data-market-card-state";
export const MARKET_CARD_DISABLED_ATTR = "data-market-card-disabled";
export const MARKET_CARD_FOCUS_ATTR = "data-market-card-focus";
export const MARKET_CARD_GRID_ATTR = "data-market-card-grid";

export type MarketCardLifecycleState =
  | "open"
  | "pending"
  | "accepted"
  | "active"
  | "resolved"
  | "cancelled"
  | "stale"
  | "duplicated"
  | "unknown"
  | string;

export type MarketCardNavKey =
  | "ArrowLeft"
  | "ArrowRight"
  | "ArrowUp"
  | "ArrowDown"
  | "Home"
  | "End";

export interface MarketCardNavItem {
  /** Stable market / claim id used only for focus targeting. */
  id: string;
  state?: MarketCardLifecycleState;
  /** Explicit disable (e.g. dependency failure, cancelled flow). */
  disabled?: boolean;
  /** Hidden / unmounted cards are skipped. */
  hidden?: boolean;
}

export interface ResolveNextIndexInput {
  items: MarketCardNavItem[];
  currentIndex: number;
  key: MarketCardNavKey;
  /** Grid column count at the active breakpoint (1–N). */
  columns: number;
}

/** States that remain visible but must not receive arrow-key focus. */
const NON_NAVIGABLE_STATES = new Set([
  "cancelled",
  "stale",
  "duplicated",
]);

export function normalizeMarketCardState(
  state: string | null | undefined,
): MarketCardLifecycleState {
  if (!state || typeof state !== "string") return "unknown";
  return state.trim().toLowerCase() || "unknown";
}

/**
 * Whether a market card may receive arrow-key focus / activation.
 * Cancelled, stale, duplicated, explicitly disabled, and hidden cards are skipped.
 * Resolved cards stay navigable so users can open settlement details.
 */
export function isMarketCardNavigable(item: MarketCardNavItem): boolean {
  if (item.hidden) return false;
  if (item.disabled) return false;
  const state = normalizeMarketCardState(item.state);
  if (NON_NAVIGABLE_STATES.has(state)) return false;
  if (!item.id && item.id !== "0") return false;
  return true;
}

export function isMarketCardNavKey(key: string): key is MarketCardNavKey {
  return (
    key === "ArrowLeft" ||
    key === "ArrowRight" ||
    key === "ArrowUp" ||
    key === "ArrowDown" ||
    key === "Home" ||
    key === "End"
  );
}

export function shouldActivateMarketCard(key: string): boolean {
  return key === "Enter" || key === " ";
}

/**
 * Roving tabindex: only the active navigable card is in tab order (0);
 * others are -1. Non-navigable cards stay out of the arrow sequence (-1).
 */
export function marketCardTabIndex(
  index: number,
  activeIndex: number,
  navigable: boolean,
): 0 | -1 {
  if (!navigable) return -1;
  return index === activeIndex ? 0 : -1;
}

function clampColumns(columns: number): number {
  if (!Number.isFinite(columns) || columns < 1) return 1;
  return Math.floor(columns);
}

function firstNavigableIndex(items: MarketCardNavItem[]): number {
  for (let i = 0; i < items.length; i++) {
    if (isMarketCardNavigable(items[i]!)) return i;
  }
  return -1;
}

function lastNavigableIndex(items: MarketCardNavItem[]): number {
  for (let i = items.length - 1; i >= 0; i--) {
    if (isMarketCardNavigable(items[i]!)) return i;
  }
  return -1;
}

function stepNavigable(
  items: MarketCardNavItem[],
  from: number,
  direction: 1 | -1,
): number {
  let i = from + direction;
  while (i >= 0 && i < items.length) {
    if (isMarketCardNavigable(items[i]!)) return i;
    i += direction;
  }
  return from;
}

/**
 * Compute the next focused card index for arrow / home / end keys.
 * Returns the current index when the move is a no-op (boundary), or -1 when
 * there is no navigable card at all.
 */
export function resolveNextMarketCardIndex(
  input: ResolveNextIndexInput,
): number {
  const { items, key } = input;
  const columns = clampColumns(input.columns);
  const navigableCount = items.filter(isMarketCardNavigable).length;
  if (navigableCount === 0) return -1;

  let current = input.currentIndex;
  if (
    current < 0 ||
    current >= items.length ||
    !isMarketCardNavigable(items[current]!)
  ) {
    current = firstNavigableIndex(items);
    if (current < 0) return -1;
  }

  switch (key) {
    case "Home":
      return firstNavigableIndex(items);
    case "End":
      return lastNavigableIndex(items);
    case "ArrowLeft":
      return stepNavigable(items, current, -1);
    case "ArrowRight":
      return stepNavigable(items, current, 1);
    case "ArrowUp": {
      const target = current - columns;
      if (target < 0) return current;
      if (isMarketCardNavigable(items[target]!)) return target;
      // Prefer nearest navigable in that row walking left, then right.
      for (let i = target; i >= Math.max(0, target - (columns - 1)); i--) {
        if (isMarketCardNavigable(items[i]!)) return i;
      }
      for (let i = target + 1; i <= Math.min(items.length - 1, target + (columns - 1)); i++) {
        if (isMarketCardNavigable(items[i]!)) return i;
      }
      return current;
    }
    case "ArrowDown": {
      const target = current + columns;
      if (target >= items.length) return current;
      if (isMarketCardNavigable(items[target]!)) return target;
      for (let i = target; i >= Math.max(0, target - (columns - 1)); i--) {
        if (isMarketCardNavigable(items[i]!)) return i;
      }
      for (let i = target + 1; i <= Math.min(items.length - 1, target + (columns - 1)); i++) {
        if (isMarketCardNavigable(items[i]!)) return i;
      }
      return current;
    }
    default:
      return current;
  }
}

export interface MarketCardKeyDecision {
  type: "none" | "move" | "activate";
  nextIndex: number;
  preventDefault: boolean;
}

/**
 * Pure key handler decision for a focused market card inside a grid.
 * Callers apply focus / click based on the decision — no DOM here.
 */
export function decideMarketCardKey(
  key: string,
  input: Omit<ResolveNextIndexInput, "key"> & { key?: string },
): MarketCardKeyDecision {
  if (shouldActivateMarketCard(key)) {
    const idx =
      input.currentIndex >= 0 &&
      input.currentIndex < input.items.length &&
      isMarketCardNavigable(input.items[input.currentIndex]!)
        ? input.currentIndex
        : firstNavigableIndex(input.items);
    return {
      type: idx >= 0 ? "activate" : "none",
      nextIndex: idx,
      preventDefault: idx >= 0 && key === " ",
    };
  }

  if (!isMarketCardNavKey(key)) {
    return { type: "none", nextIndex: input.currentIndex, preventDefault: false };
  }

  const nextIndex = resolveNextMarketCardIndex({
    items: input.items,
    currentIndex: input.currentIndex,
    key,
    columns: input.columns,
  });

  if (nextIndex < 0) {
    return { type: "none", nextIndex: -1, preventDefault: false };
  }

  return {
    type: nextIndex === input.currentIndex ? "none" : "move",
    nextIndex,
    preventDefault: nextIndex !== input.currentIndex,
  };
}

/** Infer grid columns from a CSS grid template or explicit override. */
export function inferGridColumns(
  columnCountHint: number | null | undefined,
  itemCount: number,
): number {
  if (columnCountHint != null && columnCountHint >= 1) {
    return clampColumns(columnCountHint);
  }
  // Fallback: treat as a single column list when unknown.
  return itemCount > 0 ? 1 : 1;
}

/**
 * Build nav items from lightweight descriptors (tests / SSR fixtures).
 * Invalid / missing ids are marked hidden so they drop out of the sequence.
 */
export function buildMarketCardNavItems(
  cards: Array<{
    id: string | number | null | undefined;
    state?: string | null;
    disabled?: boolean;
    hidden?: boolean;
  }>,
): MarketCardNavItem[] {
  return cards.map((card) => {
    const id =
      card.id === null || card.id === undefined ? "" : String(card.id);
    return {
      id,
      state: normalizeMarketCardState(card.state ?? undefined),
      disabled: Boolean(card.disabled),
      hidden: Boolean(card.hidden) || id === "",
    };
  });
}
