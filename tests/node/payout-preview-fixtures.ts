/**
 * Deterministic fixtures for the principal-safe payout preview.
 *
 * Everything is integer atomic USDC at 7 decimals, built from the same helpers the
 * app uses — no network, no clock, no contract read. A preview fixture that
 * carried its own decimals or its own bps arithmetic could agree with the code by
 * construction and prove nothing, so the bps defaults come from `FEE_SCHEDULE`
 * (`lib/fees.ts`) and every amount goes through `usdcToUnits` (`lib/usdc.ts`).
 *
 * Test-only shared code: nothing under `lib/` or `app/` imports this.
 */

import { FEE_SCHEDULE } from "../../lib/fees";
import type {
  ClaimFeeView,
  PayoutBreakdown,
  PayoutFeeState,
  PayoutFeeTerms,
} from "../../lib/payout";
import { usdcToUnits } from "../../lib/usdc";

/** Atomic USDC. Throws on more than 7 fractional digits, as the app does. */
export const U = usdcToUnits;

/**
 * StrKey-shaped recipients. Valid-looking on purpose: the preview's only
 * address-sensitive rule is "a leg with no recipient is not charged", and a
 * fixture that passed `""` everywhere could not tell that apart from a bug.
 */
export const PLATFORM_RECIPIENT =
  "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
export const AGENT_OWNER_RECIPIENT =
  "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBZ2Z";
export const VIEWER =
  "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC5LM";

/**
 * The claim snapshot the deployed contract writes for an attributed market: the
 * published schedule, both legs funded. Override a field to model one leg.
 */
export function feeTerms(overrides: Partial<PayoutFeeTerms> = {}): PayoutFeeTerms {
  return {
    platformFeeBps: FEE_SCHEDULE.platformBps,
    agentOwnerFeeBps: FEE_SCHEDULE.agentOwnerBps,
    platformRecipient: PLATFORM_RECIPIENT,
    agentOwnerRecipient: AGENT_OWNER_RECIPIENT,
    ...overrides,
  };
}

/** The same terms as `getClaimFees` decodes them, for the adapter's test. */
export function claimFeeView(overrides: Partial<ClaimFeeView> = {}): ClaimFeeView {
  const terms = feeTerms();
  return {
    platform_fee_bps: terms.platformFeeBps,
    agent_owner_fee_bps: terms.agentOwnerFeeBps,
    platform_recipient: terms.platformRecipient,
    agent_owner_recipient: terms.agentOwnerRecipient,
    ...overrides,
  };
}

export const readyFees = (overrides: Partial<PayoutFeeTerms> = {}): PayoutFeeState => ({
  status: "ready",
  terms: feeTerms(overrides),
});

export const loadingFees: PayoutFeeState = { status: "loading" };
export const unavailableFees: PayoutFeeState = { status: "unavailable" };
export const invalidFees: PayoutFeeState = { status: "invalid" };

/** A gross breakdown with an explicit profit, for testing the fee step alone. */
export function gross(stakeUsdc: number, profitUsdc: number): PayoutBreakdown {
  return grossUnits(U(stakeUsdc), U(profitUsdc));
}

/**
 * The same, from atomic units. Needed for profits below `1e-6`, where a JS number
 * stringifies as `1e-7` and the 7-decimal parser refuses it — the boundary the
 * fee rounding tests care about most.
 */
export function grossUnits(
  returnedPrincipalUnits: bigint,
  netProfitUnits: bigint,
): PayoutBreakdown {
  return {
    totalReturnUnits: returnedPrincipalUnits + netProfitUnits,
    returnedPrincipalUnits,
    netProfitUnits,
  };
}

/**
 * The golden pool market from `tests/node/pool-payout.test.ts` §6.1: a 10 USDC
 * creator against a challenger side that reaches 100 once this 10 joins. So the
 * pool BEFORE the join is 90, and the winning challenger makes exactly 1 USDC of
 * profit — a number small enough that a fee bug shows up as cents.
 */
export const GOLDEN = {
  stakeUsdc: 10,
  creatorStakeUsdc: 10,
  challengerPoolBeforeUsdc: 90,
} as const;
