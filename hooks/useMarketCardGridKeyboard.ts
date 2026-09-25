"use client";

import { useEffect, type RefObject } from "react";
import {
  MARKET_CARD_ATTR,
  MARKET_CARD_DISABLED_ATTR,
  MARKET_CARD_FOCUS_ATTR,
  MARKET_CARD_STATE_ATTR,
  buildMarketCardNavItems,
  decideMarketCardKey,
  inferGridColumns,
  type MarketCardNavItem,
} from "@/lib/market-card-keyboard";

export interface UseMarketCardGridKeyboardOptions {
  /** Explicit column count; when omitted, inferred from computed grid style. */
  columns?: number;
}

function readCards(container: HTMLElement): {
  elements: HTMLElement[];
  items: MarketCardNavItem[];
} {
  const elements = Array.from(
    container.querySelectorAll<HTMLElement>(`[${MARKET_CARD_ATTR}]`),
  );
  const items = buildMarketCardNavItems(
    elements.map((el) => ({
      id: el.getAttribute(MARKET_CARD_ATTR),
      state: el.getAttribute(MARKET_CARD_STATE_ATTR),
      disabled:
        el.getAttribute(MARKET_CARD_DISABLED_ATTR) === "true" ||
        el.getAttribute("aria-disabled") === "true",
      hidden:
        el.hidden ||
        el.getAttribute("aria-hidden") === "true" ||
        el.getAttribute(MARKET_CARD_ATTR) === "",
    })),
  );
  return { elements, items };
}

function focusTargetFor(card: HTMLElement): HTMLElement {
  const marked = card.querySelector<HTMLElement>(`[${MARKET_CARD_FOCUS_ATTR}]`);
  if (marked) return marked;
  const link = card.querySelector<HTMLElement>("a[href]");
  if (link) return link;
  return card;
}

function activateCard(card: HTMLElement): void {
  const target = focusTargetFor(card);
  if (typeof target.click === "function") {
    target.click();
    return;
  }
  target.focus();
}

function columnsFromContainer(
  container: HTMLElement,
  explicit?: number,
): number {
  if (explicit != null && explicit >= 1) return Math.floor(explicit);
  const style = window.getComputedStyle(container);
  const template = style.gridTemplateColumns;
  if (template && template !== "none") {
    const parts = template.split(" ").filter(Boolean);
    if (parts.length > 0) return parts.length;
  }
  return inferGridColumns(null, 0);
}

/**
 * Arrow-key / Home / End roving focus across `[data-market-card]` descendants.
 * Enter / Space activates the card's primary control.
 */
export function useMarketCardGridKeyboard(
  containerRef: RefObject<HTMLElement | null>,
  options: UseMarketCardGridKeyboardOptions = {},
): void {
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (!container.contains(target)) return;

      // Ignore when typing in inputs / contenteditable inside the grid chrome.
      const tag = target.tagName;
      if (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        target.isContentEditable
      ) {
        return;
      }

      const { elements, items } = readCards(container);
      if (elements.length === 0) return;

      const cardEl = target.closest<HTMLElement>(`[${MARKET_CARD_ATTR}]`);
      if (!cardEl || !container.contains(cardEl)) return;

      const currentIndex = elements.indexOf(cardEl);
      if (currentIndex < 0) return;

      const columns = columnsFromContainer(container, options.columns);
      const decision = decideMarketCardKey(event.key, {
        items,
        currentIndex,
        columns,
      });

      if (decision.type === "none") return;

      if (decision.preventDefault) {
        event.preventDefault();
        event.stopPropagation();
      }

      if (decision.type === "move") {
        const next = elements[decision.nextIndex];
        if (!next) return;
        focusTargetFor(next).focus();
        return;
      }

      if (decision.type === "activate") {
        const active = elements[decision.nextIndex] ?? cardEl;
        activateCard(active);
      }
    };

    container.addEventListener("keydown", onKeyDown);
    return () => container.removeEventListener("keydown", onKeyDown);
  }, [containerRef, options.columns]);
}
