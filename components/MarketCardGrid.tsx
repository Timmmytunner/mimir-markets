"use client";

import { useRef, type ReactNode } from "react";
import { MARKET_CARD_GRID_ATTR } from "@/lib/market-card-keyboard";
import { useMarketCardGridKeyboard } from "@/hooks/useMarketCardGridKeyboard";

interface MarketCardGridProps {
  children: ReactNode;
  className?: string;
  /** Explicit column count for arrow-up/down; omit to infer from CSS grid. */
  columns?: number;
  /** Accessible name for the card list region. */
  "aria-label"?: string;
}

/**
 * Grid wrapper that enables arrow-key navigation between market cards.
 */
export default function MarketCardGrid({
  children,
  className = "",
  columns,
  "aria-label": ariaLabel = "Market cards",
}: MarketCardGridProps) {
  const ref = useRef<HTMLDivElement>(null);
  useMarketCardGridKeyboard(ref, { columns });

  return (
    <div
      ref={ref}
      role="group"
      aria-label={ariaLabel}
      className={className}
      {...{ [MARKET_CARD_GRID_ATTR]: "true" }}
    >
      {children}
    </div>
  );
}
