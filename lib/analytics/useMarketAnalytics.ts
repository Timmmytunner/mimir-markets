"use client";

/**
 * Market funnel instrumentation, kept out of the page components.
 *
 * The VS page already carries a lot of state; putting `track()` calls inline
 * there makes the funnel hard to audit and easy to break. These hooks own the
 * de-duplication rules instead:
 *
 *  - `market_viewed` fires once per claim per mount, not on every re-render.
 *  - `stake_previewed` fires once per distinct (claim, stake) pair, so typing a
 *    stake digit by digit does not emit an event per keystroke.
 *  - `low_upside_warning_seen` fires once per claim per mount, because the
 *    metric is "was the user warned", not "how many renders showed the warning".
 */

import { useEffect, useRef } from "react";
import { track } from "./client";
import { idempotencyKey } from "./events";
import type { SourceSurface } from "./events";
import type { CanonicalMode } from "../market-modes";
import { SHARE_REF_PARAM, SHARE_REF_VALUE } from "../constants";

interface MarketContext {
  claimId: number;
  mode: CanonicalMode;
  category?: string;
  address?: string | null;
  surface?: SourceSurface;
}

function envelopeFor(ctx: MarketContext) {
  return {
    source_surface: ctx.surface ?? ("vs_detail" as SourceSurface),
    claim_id: ctx.claimId,
    category: ctx.category,
    subject_type: ctx.mode.subjectType,
    settlement_mode: ctx.mode.settlementMode,
    modifiers: ctx.mode.productModifiers,
  };
}

/** Records the participant returning to a resolved market to inspect the result. */
export function useSettlementReturnViewed(
  ctx: MarketContext,
  signal: { resolved: boolean; isParticipant: boolean } | null,
): void {
  const seen = useRef<number | null>(null);
  useEffect(() => {
    if (!signal?.resolved || !signal.isParticipant || seen.current === ctx.claimId) return;
    seen.current = ctx.claimId;
    track({
      event: "settlement_return_viewed",
      envelope: { ...envelopeFor(ctx), tx_status: "confirmed" },
      address: ctx.address,
      idempotencyKey: idempotencyKey(["settlement_return_viewed", ctx.claimId]),
    });
  }, [ctx, signal]);
}

/** Fires `market_viewed` once per claim per mount. */
export function useMarketViewed(ctx: MarketContext): void {
  const seen = useRef<number | null>(null);
  useEffect(() => {
    if (seen.current === ctx.claimId) return;
    seen.current = ctx.claimId;
    track({
      event: "market_viewed",
      envelope: envelopeFor(ctx),
      properties: { unsupported_mode: ctx.mode.unsupported !== undefined },
      address: ctx.address,
      idempotencyKey: idempotencyKey(["market_viewed", ctx.claimId]),
    });
    // Deliberately keyed on the claim only: re-firing on address or mode changes
    // would inflate view counts for the same market.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx.claimId]);
}

/**
 * Fires `share_card_clicked` once when a visit arrived from a shared link.
 *
 * Reads the marker from the URL rather than the Referer header: a scraper's proxy
 * rewrites the referrer, and most social apps strip it entirely, so the header
 * would under-count exactly the traffic this is meant to measure.
 *
 * The marker is a fixed literal, so this measures "shares brought traffic" and
 * cannot identify who shared it.
 */
export function useShareAttribution(ctx: MarketContext): void {
  const fired = useRef<number | null>(null);
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (fired.current === ctx.claimId) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get(SHARE_REF_PARAM) !== SHARE_REF_VALUE) return;
    fired.current = ctx.claimId;
    track({
      event: "share_card_clicked",
      envelope: envelopeFor(ctx),
      address: ctx.address,
      // Keyed on the claim alone, so a reload of the same shared link is one click
      // rather than one per visit — the funnel step is "this share worked".
      idempotencyKey: idempotencyKey(["share_card_clicked", ctx.claimId]),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx.claimId]);
}

export interface StakePreviewSignal {
  stake: number;
  /** GROSS formula output — see the note at the `vs_detail` call site. */
  totalReturn: number;
  netProfit: number;
  upsideBps: number;
  /**
   * Thin upside as the WARNING saw it, i.e. measured on the fee-adjusted net when
   * a fee snapshot was available. This is the one field here that follows the
   * user-visible number, because the metric is "was the user warned".
   */
  isLowUpside: boolean;
  /**
   * Whether the on-screen payout was fee-adjusted. Distinguishes the two cases a
   * dashboard otherwise cannot tell apart: a market with no fee, and a market
   * whose fee terms could not be read.
   */
  feeAdjusted: boolean;
}

/**
 * Fires `stake_previewed` (and `payout_preview_seen`) once per distinct stake
 * value, plus `low_upside_warning_seen` once per claim.
 *
 * Stake amounts are bucketed rather than sent raw: an exact stake plus a
 * timestamp is close to a fingerprint, and the funnel only needs the magnitude.
 */
export function useStakePreviewTracking(
  ctx: MarketContext,
  preview: StakePreviewSignal | null,
): void {
  const lastStake = useRef<number | null>(null);
  const warned = useRef(false);

  useEffect(() => {
    if (!preview || preview.stake <= 0) return;
    if (lastStake.current === preview.stake) return;
    lastStake.current = preview.stake;

    const properties = {
      stake_bucket: stakeBucket(preview.stake),
      upside_bps: preview.upsideBps,
      is_low_upside: preview.isLowUpside,
      fee_adjusted: preview.feeAdjusted,
      total_return_multiple:
        preview.stake > 0 ? Math.round((preview.totalReturn / preview.stake) * 100) / 100 : 0,
    };

    track({
      event: "stake_previewed",
      envelope: envelopeFor(ctx),
      properties,
      address: ctx.address,
      idempotencyKey: idempotencyKey(["stake_previewed", ctx.claimId, properties.stake_bucket]),
    });
    track({
      event: "payout_preview_seen",
      envelope: envelopeFor(ctx),
      properties,
      address: ctx.address,
      idempotencyKey: idempotencyKey(["payout_preview_seen", ctx.claimId, properties.stake_bucket]),
    });

    if (preview.isLowUpside && !warned.current) {
      warned.current = true;
      track({
        event: "low_upside_warning_seen",
        envelope: envelopeFor(ctx),
        properties,
        address: ctx.address,
        idempotencyKey: idempotencyKey(["low_upside_warning_seen", ctx.claimId]),
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx.claimId, preview?.stake, preview?.isLowUpside]);
}

/**
 * Coarse stake buckets. Raw amounts are avoided on purpose — combined with a
 * timestamp they are near-identifying, and conversion analysis only needs the
 * order of magnitude.
 */
export function stakeBucket(stake: number): string {
  if (stake < 2) return "<2";
  if (stake < 5) return "2-5";
  if (stake < 10) return "5-10";
  if (stake < 25) return "10-25";
  if (stake < 100) return "25-100";
  if (stake < 1_000) return "100-1000";
  return "1000+";
}
