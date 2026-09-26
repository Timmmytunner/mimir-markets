/**
 * Payout math, in USDC atomic units — the single source shared by the stake
 * preview, the explorer cards and the tests.
 *
 * Every function here mirrors `contracts-soroban/mimir-market/src/fees.rs`
 * **exactly**, including integer truncation. The UI used to preview pool payouts
 * with floating-point division, which drifts from the contract by up to a dust
 * unit per challenger and can promise a number the settlement will not pay.
 * Preview in atomic integers, convert to decimals only for display.
 *
 * The arithmetic survived the move from Solidity to Soroban unchanged — the
 * formulas below are the same, and `i128` truncating division behaves like the
 * `uint256` it replaced. What DID change is the scale underneath: an atomic unit
 * is now 10^-7 USDC, not 10^-6 (see lib/usdc.ts). Nothing here depends on the
 * exponent, so the conversion helpers absorb it.
 *
 * Vocabulary is deliberate and must not be collapsed in the UI:
 *   totalReturn      what lands in the wallet on a win (principal + profit)
 *   returnedPrincipal the stake coming back
 *   netProfit        totalReturn - returnedPrincipal
 * "2x" always means 2x TOTAL RETURN, never 2x profit.
 */

import { unitsToUsdc, usdcToUnits } from "./usdc";
import {
  MAX_TOTAL_FEE_BPS,
  snapshotFeePolicy,
  splitFees,
  type FeeSplit,
  type SettlementOutcome,
} from "./fees";

export const BPS_DIVISOR_UNITS = 10_000n;

export interface PayoutBreakdown {
  /** Everything the winner receives, atomic units. */
  totalReturnUnits: bigint;
  /** The winner's own stake, returned. */
  returnedPrincipalUnits: bigint;
  /** Winnings on top of the principal. */
  netProfitUnits: bigint;
}

function breakdown(totalReturnUnits: bigint, stakeUnits: bigint): PayoutBreakdown {
  const returned = totalReturnUnits < stakeUnits ? totalReturnUnits : stakeUnits;
  return {
    totalReturnUnits,
    returnedPrincipalUnits: returned,
    netProfitUnits: totalReturnUnits - returned,
  };
}

/**
 * A pool challenger's payout, mirroring `fees.rs::pool_share`:
 *
 *   share  = (chStake * creatorStake) / totalChallengerStake   // integer floor
 *   payout = chStake + share
 *
 * `challengerPoolUnits` must be the pool AFTER this stake joins — that is what
 * the contract divides by at settlement, so previewing against the pre-join pool
 * overstates the payout.
 */
export function poolChallengerPayoutUnits(args: {
  stakeUnits: bigint;
  creatorStakeUnits: bigint;
  challengerPoolUnits: bigint;
}): PayoutBreakdown {
  const { stakeUnits, creatorStakeUnits, challengerPoolUnits } = args;
  if (stakeUnits <= 0n) return breakdown(0n, 0n);
  if (challengerPoolUnits <= 0n) return breakdown(stakeUnits, stakeUnits);
  const share = (stakeUnits * creatorStakeUnits) / challengerPoolUnits;
  return breakdown(stakeUnits + share, stakeUnits);
}

/** Pool creator's payout on a win: the whole pot. */
export function poolCreatorPayoutUnits(args: {
  creatorStakeUnits: bigint;
  challengerPoolUnits: bigint;
}): PayoutBreakdown {
  const total = args.creatorStakeUnits + args.challengerPoolUnits;
  return breakdown(total, args.creatorStakeUnits);
}

/**
 * Fixed-odds challenger payout, mirroring `fees.rs::gross_payout`:
 *   (stake * bps) / 10_000
 * bps is a TOTAL RETURN multiple: 20_000 = 2x total return = 1x profit.
 */
export function fixedOddsPayoutUnits(args: {
  stakeUnits: bigint;
  challengerPayoutBps: number;
}): PayoutBreakdown {
  const bps = BigInt(Math.max(0, Math.trunc(args.challengerPayoutBps)));
  if (args.stakeUnits <= 0n || bps <= 0n) return breakdown(0n, 0n);
  return breakdown((args.stakeUnits * bps) / BPS_DIVISOR_UNITS, args.stakeUnits);
}

/**
 * How much challenger stake a fixed-odds market can absorb.
 *
 * Inverse of the liability calculation: the creator backs the challenger's PROFIT,
 * so capacity is stake / (multiple - 1). At 2x a 10 USDC creator can take 10 USDC
 * of challenges; at 3x only 5. Worth stating because raising the promised multiple
 * silently shrinks the market.
 *
 * A multiple at or below 1x returns 0 rather than dividing by zero — such a market
 * is rejected by validateMode anyway, and an infinite capacity would render as a
 * market that can absorb anything.
 */
export function fixedOddsCapacityUnits(args: {
  creatorStakeUnits: bigint;
  challengerPayoutBps: number;
}): bigint {
  const bps = BigInt(Math.max(0, Math.trunc(args.challengerPayoutBps)));
  if (bps <= BPS_DIVISOR_UNITS || args.creatorStakeUnits <= 0n) return 0n;
  // Integer division floors, so capacity never promises a unit the creator cannot
  // cover — the rounding always favours the escrow.
  return (args.creatorStakeUnits * BPS_DIVISOR_UNITS) / (bps - BPS_DIVISOR_UNITS);
}

/**
 * Creator liability a fixed-odds challenge reserves — the challenger's PROFIT,
 * not the gross payout. Mirrors the contract's `reserved_creator_liability`
 * update in `claims.rs`, which `resolve.rs` then relies on to return the
 * creator's unspent liability without walking the roster.
 */
export function fixedOddsReservedLiabilityUnits(args: {
  stakeUnits: bigint;
  challengerPayoutBps: number;
}): bigint {
  return fixedOddsPayoutUnits(args).netProfitUnits;
}

/** Unreserved creator liquidity still available to back new fixed-odds stakes. */
export function availableCreatorLiquidityUnits(args: {
  creatorStakeUnits: bigint;
  reservedLiabilityUnits: bigint;
}): bigint {
  const available = args.creatorStakeUnits - args.reservedLiabilityUnits;
  return available > 0n ? available : 0n;
}

/** Largest stake this fixed-odds market can still accept. */
export function maxFixedOddsStakeUnits(args: {
  availableLiquidityUnits: bigint;
  challengerPayoutBps: number;
}): bigint {
  const bps = BigInt(Math.max(0, Math.trunc(args.challengerPayoutBps)));
  if (bps <= BPS_DIVISOR_UNITS) return 0n;
  // profit = stake * (bps - 10000) / 10000 <= available
  return (args.availableLiquidityUnits * BPS_DIVISOR_UNITS) / (bps - BPS_DIVISOR_UNITS);
}

// ── Pool shape / discovery ────────────────────────────────────────────────────

export type PoolSide = "creator" | "challengers";

export interface PoolBalance {
  creatorStakeUnits: bigint;
  challengerPoolUnits: bigint;
  totalPotUnits: bigint;
  /** Creator share of the pot in basis points; 5000 = balanced. */
  creatorShareBps: number;
  /** The side holding less money — the one with payout upside. Null when even. */
  minoritySide: PoolSide | null;
  crowdedSide: PoolSide | null;
  /** |creatorShare - 50%| in bps. 0 = perfectly balanced, 5000 = one-sided. */
  imbalanceBps: number;
}

export function poolBalance(args: {
  creatorStakeUnits: bigint;
  challengerPoolUnits: bigint;
}): PoolBalance {
  const { creatorStakeUnits, challengerPoolUnits } = args;
  const totalPotUnits = creatorStakeUnits + challengerPoolUnits;
  if (totalPotUnits <= 0n) {
    return {
      creatorStakeUnits,
      challengerPoolUnits,
      totalPotUnits,
      creatorShareBps: 5_000,
      minoritySide: null,
      crowdedSide: null,
      imbalanceBps: 0,
    };
  }
  const creatorShareBps = Number((creatorStakeUnits * BPS_DIVISOR_UNITS) / totalPotUnits);
  const even = creatorStakeUnits === challengerPoolUnits;
  const creatorIsMinority = creatorStakeUnits < challengerPoolUnits;
  return {
    creatorStakeUnits,
    challengerPoolUnits,
    totalPotUnits,
    creatorShareBps,
    minoritySide: even ? null : creatorIsMinority ? "creator" : "challengers",
    crowdedSide: even ? null : creatorIsMinority ? "challengers" : "creator",
    imbalanceBps: Math.abs(creatorShareBps - 5_000),
  };
}

/**
 * Net profit as a fraction of stake, in bps. 10_000 = doubling your money.
 * This is payout asymmetry only — never a claim about the chance of winning.
 */
export function upsideBps(payout: PayoutBreakdown): number {
  if (payout.returnedPrincipalUnits <= 0n) return 0;
  return Number((payout.netProfitUnits * BPS_DIVISOR_UNITS) / payout.returnedPrincipalUnits);
}

/**
 * Below this, joining is mostly principal risk for little upside — the crowded
 * side of a lopsided pool. 2000 bps = you risk your stake to win 20% of it.
 */
export const LOW_UPSIDE_BPS = 2_000;

export function isLowUpside(payout: PayoutBreakdown): boolean {
  return payout.netProfitUnits > 0n && upsideBps(payout) < LOW_UPSIDE_BPS;
}

// ── Display helpers ───────────────────────────────────────────────────────────

export interface PayoutDisplay {
  totalReturn: number;
  returnedPrincipal: number;
  netProfit: number;
  /** Total-return multiple, e.g. 2 for 2x. 0 when there is no stake. */
  totalReturnMultiple: number;
  upsideBps: number;
  isLowUpside: boolean;
}

export function toPayoutDisplay(payout: PayoutBreakdown): PayoutDisplay {
  const returnedPrincipal = unitsToUsdc(payout.returnedPrincipalUnits);
  return {
    totalReturn: unitsToUsdc(payout.totalReturnUnits),
    returnedPrincipal,
    netProfit: unitsToUsdc(payout.netProfitUnits),
    totalReturnMultiple:
      payout.returnedPrincipalUnits > 0n
        ? unitsToUsdc(payout.totalReturnUnits) / returnedPrincipal
        : 0,
    upsideBps: upsideBps(payout),
    isLowUpside: isLowUpside(payout),
  };
}

/**
 * A challenger's gross payout from display-USDC inputs, in atomic units.
 *
 * The atomic breakdown is kept separate from the display wrapper because the
 * fee-aware preview below has to split THIS breakdown — converting to decimals
 * first would put floating point back into the accounting path the module exists
 * to keep integer-exact.
 */
export function challengerPayoutUnits(args: {
  settlementMode: "pool" | "duel" | "fixed_odds" | "squad_pool";
  /** The stake being previewed, display USDC. */
  stake: number;
  creatorStake: number;
  /** Challenger pool BEFORE this stake joins, display USDC. */
  challengerPoolBefore: number;
  challengerPayoutBps?: number;
}): PayoutBreakdown {
  const stakeUnits = usdcToUnits(args.stake);
  const creatorStakeUnits = usdcToUnits(args.creatorStake);

  if (args.settlementMode === "fixed_odds") {
    return fixedOddsPayoutUnits({ stakeUnits, challengerPayoutBps: args.challengerPayoutBps ?? 0 });
  }
  if (args.settlementMode === "duel") {
    // Winner takes the two-person pot; stakes are equal by policy.
    return breakdown(stakeUnits + creatorStakeUnits, stakeUnits);
  }
  return poolChallengerPayoutUnits({
    stakeUnits,
    creatorStakeUnits,
    challengerPoolUnits: usdcToUnits(args.challengerPoolBefore) + stakeUnits,
  });
}

/**
 * Preview a challenger's payout from display-USDC inputs. Converts to atomic
 * units first so the preview matches settlement to the unit.
 *
 * GROSS, pre-fee. Prefer {@link previewChallengerPayoutSafe} anywhere a user will
 * act on the number: fees are charged on settlement, so this figure is not what
 * lands in the wallet.
 */
export function previewChallengerPayout(args: {
  settlementMode: "pool" | "duel" | "fixed_odds" | "squad_pool";
  /** The stake being previewed, display USDC. */
  stake: number;
  creatorStake: number;
  /** Challenger pool BEFORE this stake joins, display USDC. */
  challengerPoolBefore: number;
  challengerPayoutBps?: number;
}): PayoutDisplay {
  return toPayoutDisplay(challengerPayoutUnits(args));
}

// ── Principal-safe, fee-aware preview ─────────────────────────────────────────

/**
 * A claim's fee terms, as the contract snapshotted them at create time (adapted
 * from the snake_case `ClaimFeeView` by {@link feeStateFromClaimFees}).
 *
 * Deliberately NOT read from the live policy: a market's economics are frozen
 * under its participants, so the snapshot is the only correct input to a preview
 * for an existing claim.
 */
export interface PayoutFeeTerms {
  platformFeeBps: number;
  agentOwnerFeeBps: number;
  platformRecipient: string | null;
  agentOwnerRecipient: string | null;
}

/**
 * Why the fee terms may or may not be part of the preview.
 *
 *  ready       the claim's snapshot was read; the net is contract-backed.
 *  loading     the read is in flight.
 *  unavailable the read failed, or no market contract is configured.
 *  invalid     the read answered with a snapshot the contract could not have
 *              written (negative or over-cap bps).
 *
 * Every non-`ready` state previews the GROSS. That is the safe direction — an
 * unknown fee can only make the real payout lower — so the UI must label it and
 * never present the gross as take-home.
 */
export type PayoutFeeStatus = "ready" | "loading" | "unavailable" | "invalid";

export type PayoutFeeState =
  | { status: "ready"; terms: PayoutFeeTerms }
  | { status: "loading" }
  | { status: "unavailable" }
  | { status: "invalid" };

/** The state to use before a reader has answered. */
export const PENDING_FEE_STATE: PayoutFeeState = { status: "loading" };

/**
 * Whether a snapshot could have been written by the contract.
 *
 * The contract refuses to record `platform_fee_bps + agent_owner_fee_bps` above
 * `MAX_TOTAL_FEE_BPS`, so anything above it is not describing a claim this
 * contract created. Refusing it — rather than clamping silently — keeps a corrupt
 * read from being laundered into a number someone would stake against.
 */
export function isPlausibleFeeTerms(terms: PayoutFeeTerms): boolean {
  const { platformFeeBps, agentOwnerFeeBps } = terms;
  if (!Number.isInteger(platformFeeBps) || platformFeeBps < 0) return false;
  if (!Number.isInteger(agentOwnerFeeBps) || agentOwnerFeeBps < 0) return false;
  return BigInt(platformFeeBps) + BigInt(agentOwnerFeeBps) <= MAX_TOTAL_FEE_BPS;
}

/** Classify fee terms into the state the preview consumes. */
export function feeStateFromTerms(terms: PayoutFeeTerms | null | undefined): PayoutFeeState {
  if (!terms) return { status: "unavailable" };
  return isPlausibleFeeTerms(terms) ? { status: "ready", terms } : { status: "invalid" };
}

/**
 * The snake_case view `getClaimFees` decodes, i.e. the contract's own field names.
 * Kept separate from {@link PayoutFeeTerms} so one name for one shape: the adapter
 * below is the only place the two meet, and it is tested.
 */
export interface ClaimFeeView {
  platform_fee_bps: number;
  agent_owner_fee_bps: number;
  platform_recipient: string | null;
  agent_owner_recipient: string | null;
}

/** Classify a `getClaimFees` answer into the state the preview consumes. */
export function feeStateFromClaimFees(view: ClaimFeeView | null | undefined): PayoutFeeState {
  if (!view) return { status: "unavailable" };
  return feeStateFromTerms({
    platformFeeBps: view.platform_fee_bps,
    agentOwnerFeeBps: view.agent_owner_fee_bps,
    platformRecipient: view.platform_recipient,
    agentOwnerRecipient: view.agent_owner_recipient,
  });
}

/** The gross math plus the fee split the claim's snapshot will apply to it. */
export interface PrincipalSafePayout {
  /** Pool / duel / fixed-odds math, pre-fee. Untouched by the fee step. */
  gross: PayoutBreakdown;
  /** The contract's `quote_fees` arithmetic over the gross. */
  split: FeeSplit;
  feeState: PayoutFeeState;
  /** True when a fee leg had to be clamped to profit to protect principal. */
  clamped: boolean;
}

/**
 * The invariant every preview must keep: a winner keeps every unit of principal.
 *
 * Fees are charged on profit, never on the gross, so this holds for any snapshot
 * the contract would accept. Exported so the UI, the tests and any future
 * consumer assert the same thing rather than restating the comparison.
 */
export function isPrincipalSafe(payout: Pick<PrincipalSafePayout, "split">): boolean {
  return payout.split.payoutUnits >= payout.split.principalUnits;
}

/**
 * Split a gross payout with the claim's snapshotted fees — off-chain mirror of
 * `fees.rs::quote_fees`, plus the one guarantee a preview needs that the contract
 * enforces only implicitly:
 *
 *   payout >= principal
 *
 * `splitFees` already charges on profit only, so the guarantee holds for any
 * valid snapshot. The clamp below is the backstop for what it cannot cover: a
 * snapshot that was never valid, or a future change to the fee math. A "preview"
 * that can promise less than the stake is not a preview; it is a bug that costs
 * someone money.
 *
 * With no fee terms the gross passes through untouched and `payoutUnits` equals
 * `totalReturnUnits` — the caller is responsible for saying so (see
 * {@link PrincipalSafePayoutPreview.feeAdjusted}).
 */
export function principalSafePayout(args: {
  gross: PayoutBreakdown;
  feeState: PayoutFeeState;
  /** A winning challenger by default. Only non-refund outcomes take a fee. */
  outcome?: SettlementOutcome;
}): PrincipalSafePayout {
  const { gross, feeState, outcome = "challengers_win" } = args;
  const principalUnits = gross.returnedPrincipalUnits;

  if (feeState.status !== "ready") {
    return {
      gross,
      feeState,
      clamped: false,
      split: {
        principalUnits,
        grossProfitUnits: gross.netProfitUnits,
        platformFeeUnits: 0n,
        agentOwnerFeeUnits: 0n,
        netProfitUnits: gross.netProfitUnits,
        payoutUnits: gross.totalReturnUnits,
      },
    };
  }

  const split = splitFees({
    principalUnits,
    grossPayoutUnits: gross.totalReturnUnits,
    outcome,
    snapshot: snapshotFeePolicy(
      {
        platformFeeBps: feeState.terms.platformFeeBps,
        agentOwnerFeeBps: feeState.terms.agentOwnerFeeBps,
        platformRecipient: feeState.terms.platformRecipient ?? "",
        agentOwnerRecipient: feeState.terms.agentOwnerRecipient,
      },
      // The preview is not a policy snapshot; `takenAt` is unused by `splitFees`
      // and a fixed value keeps the function pure and the tests deterministic.
      { at: 0 },
    ),
  });

  const profitUnits = gross.netProfitUnits;
  let platformFeeUnits = split.platformFeeUnits;
  let agentOwnerFeeUnits = split.agentOwnerFeeUnits;
  let clamped = false;
  if (platformFeeUnits + agentOwnerFeeUnits > profitUnits) {
    // Clamp to profit, platform leg first (the contract's own leg order), so the
    // total deduction can never reach the stake.
    platformFeeUnits = platformFeeUnits > profitUnits ? profitUnits : platformFeeUnits;
    agentOwnerFeeUnits = profitUnits - platformFeeUnits;
    clamped = true;
  }

  const totalFeeUnits = platformFeeUnits + agentOwnerFeeUnits;
  return {
    gross,
    feeState,
    clamped,
    split: {
      principalUnits,
      grossProfitUnits: split.grossProfitUnits,
      platformFeeUnits,
      agentOwnerFeeUnits,
      netProfitUnits: profitUnits - totalFeeUnits,
      payoutUnits: gross.totalReturnUnits - totalFeeUnits,
    },
  };
}

/**
 * Display form of a {@link PrincipalSafePayout}.
 *
 * `netPayout` is the only "what you receive" number, and `feeAdjusted` says
 * whether that number has fees taken out of it. When it is false, `netPayout`
 * equals the gross: the honest thing to show, because the alternative (assuming a
 * fee) would invent a number, but it must be labelled.
 */
export interface PrincipalSafePayoutPreview {
  /** Gross, pre-fee display numbers — the same ones `previewChallengerPayout` returns. */
  gross: PayoutDisplay;
  feeStatus: PayoutFeeStatus;
  /** The stake coming back, whole. Fees never touch it. */
  principal: number;
  platformFee: number;
  agentOwnerFee: number;
  totalFee: number;
  /** What the wallet receives on a win. Gross until `feeAdjusted` is true. */
  netPayout: number;
  /** `netPayout - principal`, i.e. profit after fees. */
  netProfit: number;
  /** `netPayout / principal` as a total-return multiple. 0 with no stake. */
  netMultiple: number;
  /** Net profit as bps of principal. 10_000 = doubling the money after fees. */
  netUpsideBps: number;
  /**
   * Thin upside measured on the NET, not the gross. A fee can be the difference
   * between "worth it" and "mostly principal risk", so the warning has to use the
   * number the user will actually receive.
   */
  isLowUpside: boolean;
  /** True once the claim's snapshot was applied, so `netPayout` is exact. */
  feeAdjusted: boolean;
  /** True when a fee had to be clamped to profit to keep principal whole. */
  clamped: boolean;
}

export function toPrincipalSafePreview(payout: PrincipalSafePayout): PrincipalSafePayoutPreview {
  const principal = unitsToUsdc(payout.split.principalUnits);
  const netPayout = unitsToUsdc(payout.split.payoutUnits);
  // The same helpers the gross path uses, over the net split, so "low upside"
  // means the same thing whichever side of the fee it is measured on.
  const net: PayoutBreakdown = {
    totalReturnUnits: payout.split.payoutUnits,
    returnedPrincipalUnits: payout.split.principalUnits,
    netProfitUnits: payout.split.netProfitUnits,
  };
  return {
    gross: toPayoutDisplay(payout.gross),
    feeStatus: payout.feeState.status,
    principal,
    platformFee: unitsToUsdc(payout.split.platformFeeUnits),
    agentOwnerFee: unitsToUsdc(payout.split.agentOwnerFeeUnits),
    totalFee: unitsToUsdc(payout.split.platformFeeUnits + payout.split.agentOwnerFeeUnits),
    netPayout,
    netProfit: unitsToUsdc(payout.split.netProfitUnits),
    netMultiple: principal > 0 ? netPayout / principal : 0,
    netUpsideBps: upsideBps(net),
    isLowUpside: isLowUpside(net),
    feeAdjusted: payout.feeState.status === "ready",
    clamped: payout.clamped,
  };
}

/**
 * The preview the market detail UI renders: the same gross math as
 * {@link previewChallengerPayout}, then the claim's snapshotted fees applied.
 *
 * The fee split does not depend on WHO is looking — the contract charges an
 * agent-owner leg whenever the claim has a recipient and does not waive it by
 * earner — so no viewer address is an input and a disconnected viewer computes the
 * same net as a connected challenger. That is why there is no "not connected"
 * preview state here: connection gates the stake form and the action, not the
 * number.
 */
export function previewChallengerPayoutSafe(args: {
  settlementMode: "pool" | "duel" | "fixed_odds" | "squad_pool";
  stake: number;
  creatorStake: number;
  challengerPoolBefore: number;
  challengerPayoutBps?: number;
  /** Defaults to `unavailable`, which previews the gross and says so. */
  fees?: PayoutFeeState;
}): PrincipalSafePayoutPreview {
  return toPrincipalSafePreview(
    principalSafePayout({
      gross: challengerPayoutUnits(args),
      feeState: args.fees ?? { status: "unavailable" },
    }),
  );
}
