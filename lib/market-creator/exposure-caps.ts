/**
 * Creator open-exposure caps for the market-creator agent.
 *
 * `lib/market-creator/mode-matrix.ts` already refuses a candidate whose stake
 * would push open exposure past `maxOpenExposureUsdc`. This module is the
 * accounting half: what counts as open exposure from Soroban claim state, how
 * to sum it, and whether posting another stake is allowed.
 *
 * Soroban remains authoritative. We only read decoded claim snapshots; we never
 * invent balances. Malformed stakes, expired markets, cancelled/resolved rows,
 * and other creators' claims do not count.
 */

export type CreatorExposureState = "open" | "active" | "resolved" | "cancelled" | string;

/** Minimal claim slice needed to decide whether funds are still at risk. */
export interface CreatorExposureClaim {
  id: number;
  creator: string;
  state: CreatorExposureState;
  /** Unix seconds. */
  deadline: number;
  /** Creator stake in display USDC (post `unitsToUsdc`). */
  creatorStakeUsdc: number;
  /**
   * Fixed-odds liability already reserved against the creator, display USDC.
   * Pool markets leave this at 0 / undefined.
   */
  reservedCreatorLiabilityUsdc?: number;
}

export interface ExposureCapPolicy {
  /** Hard ceiling on open creator exposure, display USDC. */
  maxOpenExposureUsdc: number;
}

export type ExposureSkipReason =
  | "other_creator"
  | "not_open"
  | "expired"
  | "malformed_stake"
  | "duplicate";

export interface ExposureCapDecision {
  allowed: boolean;
  /** Open exposure before this stake. */
  openExposureUsdc: number;
  /** Open exposure if the stake posts. */
  nextExposureUsdc: number;
  /** Headroom before the stake. */
  headroomUsdc: number;
  /** Stable machine reason when refused. */
  reason?: "cap_exceeded" | "invalid_stake" | "invalid_cap" | "invalid_open_exposure";
  /** Human-readable blocker for logs / proposal records. */
  blockedBy?: string;
}

const LIVE_STATES = new Set(["open", "active"]);

function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * Validate policy from env / caller input.
 *
 * A NaN or negative ceiling must not silently become "unlimited" — that would
 * disable the funded-state safety this module exists to enforce.
 */
export function parseExposureCapPolicy(
  input: { maxOpenExposureUsdc?: unknown } | Record<string, string | undefined>,
): { ok: true; policy: ExposureCapPolicy } | { ok: false; error: string } {
  const raw =
    "maxOpenExposureUsdc" in input && input.maxOpenExposureUsdc !== undefined
      ? input.maxOpenExposureUsdc
      : (input as Record<string, string | undefined>).MARKET_CREATOR_MAX_EXPOSURE_USDC;

  const value =
    typeof raw === "number"
      ? raw
      : typeof raw === "string" && raw.trim() !== ""
        ? Number(raw)
        : typeof raw === "undefined" || raw === null
          ? 100
          : Number.NaN;

  if (!Number.isFinite(value) || value < 0) {
    return { ok: false, error: `maxOpenExposureUsdc must be a finite number ≥ 0 (got ${String(raw)})` };
  }
  return { ok: true, policy: { maxOpenExposureUsdc: value } };
}

/**
 * Would this claim's locked creator funds still count toward open exposure?
 *
 * - other creator → no
 * - resolved / cancelled → no (funds returned or settled on-chain)
 * - deadline passed → no (stale OPEN is swept separately; exposure is live risk)
 * - non-finite / negative stake → no (malformed decode must not inflate the sum)
 */
export function exposureSkipReason(
  claim: CreatorExposureClaim,
  creatorAddress: string,
  nowSeconds: number,
  seenIds?: Set<number>,
): ExposureSkipReason | null {
  if (seenIds?.has(claim.id)) return "duplicate";
  if (claim.creator !== creatorAddress) return "other_creator";
  if (!LIVE_STATES.has(String(claim.state).toLowerCase())) return "not_open";
  if (!Number.isFinite(claim.deadline) || claim.deadline <= nowSeconds) return "expired";
  if (!finiteNonNegative(claim.creatorStakeUsdc)) return "malformed_stake";
  const reserved = claim.reservedCreatorLiabilityUsdc;
  if (reserved !== undefined && !finiteNonNegative(reserved)) return "malformed_stake";
  return null;
}

/** Locked creator USDC still at risk on one live claim. */
export function exposureUsdcForClaim(claim: CreatorExposureClaim): number {
  const stake = finiteNonNegative(claim.creatorStakeUsdc) ? claim.creatorStakeUsdc : 0;
  const reserved =
    claim.reservedCreatorLiabilityUsdc !== undefined &&
    finiteNonNegative(claim.reservedCreatorLiabilityUsdc)
      ? claim.reservedCreatorLiabilityUsdc
      : 0;
  return stake + reserved;
}

/**
 * Sum open exposure for one creator across a claim snapshot list.
 *
 * Duplicate ids (retried reads) are counted once. Non-matching / dead / malformed
 * rows are skipped rather than throwing — a partial ledger read must not halt the
 * worker, and must not pretend exposure is zero when the skip is "malformed".
 */
export function sumCreatorOpenExposure(args: {
  claims: readonly CreatorExposureClaim[];
  creatorAddress: string;
  nowSeconds: number;
}): {
  openExposureUsdc: number;
  countedClaimIds: number[];
  skipped: Array<{ id: number; reason: ExposureSkipReason }>;
} {
  const seen = new Set<number>();
  const countedClaimIds: number[] = [];
  const skipped: Array<{ id: number; reason: ExposureSkipReason }> = [];
  let openExposureUsdc = 0;

  for (const claim of args.claims) {
    const reason = exposureSkipReason(claim, args.creatorAddress, args.nowSeconds, seen);
    if (reason) {
      skipped.push({ id: claim.id, reason });
      continue;
    }
    seen.add(claim.id);
    countedClaimIds.push(claim.id);
    openExposureUsdc += exposureUsdcForClaim(claim);
  }

  return { openExposureUsdc, countedClaimIds, skipped };
}

/**
 * Enforce the cap for a stake about to be posted.
 *
 * Equality at the ceiling is allowed (matches `decideMode` in mode-matrix).
 * Dependency / paused workers are the caller's concern — this only answers the
 * money question.
 */
export function checkCreatorExposureCap(args: {
  openExposureUsdc: number;
  stakeUsdc: number;
  maxOpenExposureUsdc: number;
}): ExposureCapDecision {
  const { openExposureUsdc, stakeUsdc, maxOpenExposureUsdc } = args;

  if (!finiteNonNegative(maxOpenExposureUsdc)) {
    return {
      allowed: false,
      openExposureUsdc: Number.NaN,
      nextExposureUsdc: Number.NaN,
      headroomUsdc: Number.NaN,
      reason: "invalid_cap",
      blockedBy: `invalid maxOpenExposureUsdc ${String(maxOpenExposureUsdc)}`,
    };
  }
  if (!finiteNonNegative(openExposureUsdc)) {
    return {
      allowed: false,
      openExposureUsdc,
      nextExposureUsdc: Number.NaN,
      headroomUsdc: Number.NaN,
      reason: "invalid_open_exposure",
      blockedBy: `invalid openExposureUsdc ${String(openExposureUsdc)}`,
    };
  }
  if (!finiteNonNegative(stakeUsdc) || stakeUsdc === 0) {
    return {
      allowed: false,
      openExposureUsdc,
      nextExposureUsdc: openExposureUsdc,
      headroomUsdc: Math.max(0, maxOpenExposureUsdc - openExposureUsdc),
      reason: "invalid_stake",
      blockedBy: `stakeUsdc must be a positive finite number (got ${String(stakeUsdc)})`,
    };
  }

  const nextExposureUsdc = openExposureUsdc + stakeUsdc;
  const headroomUsdc = Math.max(0, maxOpenExposureUsdc - openExposureUsdc);

  if (nextExposureUsdc > maxOpenExposureUsdc) {
    return {
      allowed: false,
      openExposureUsdc,
      nextExposureUsdc,
      headroomUsdc,
      reason: "cap_exceeded",
      blockedBy: `${nextExposureUsdc} > ${maxOpenExposureUsdc}`,
    };
  }

  return {
    allowed: true,
    openExposureUsdc,
    nextExposureUsdc,
    headroomUsdc,
  };
}

/** How many `stakeUsdc`-sized markets still fit under the cap (floor). */
export function marketsRemainingUnderCap(args: {
  openExposureUsdc: number;
  stakeUsdc: number;
  maxOpenExposureUsdc: number;
}): number {
  if (!finiteNonNegative(args.stakeUsdc) || args.stakeUsdc <= 0) return 0;
  if (!finiteNonNegative(args.openExposureUsdc) || !finiteNonNegative(args.maxOpenExposureUsdc)) {
    return 0;
  }
  return Math.floor(Math.max(0, args.maxOpenExposureUsdc - args.openExposureUsdc) / args.stakeUsdc);
}
