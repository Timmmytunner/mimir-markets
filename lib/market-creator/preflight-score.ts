/**
 * Named preflight dimensions for the market-creator council (§10.4).
 *
 * A single blended "quality: 62" tells an operator nothing about what is wrong,
 * and a market can be excellent on three axes and unopenable on the fourth. So a
 * preflight scores four things separately and each one can veto on its own:
 *
 *   resolutionClarity  could an oracle settle this rule without guessing?
 *   sourceIndependence do the sources actually corroborate, or echo each other?
 *   liquidityFit       is the proposed stake sane for this mode and this topic?
 *   bestMode           is the requested settlement mode the right one?
 *
 * Two rules that shape everything below:
 *
 *  - **The aggregate is the MINIMUM, not the mean.** A market nobody can settle is
 *    not rescued by having wonderful sources. Averaging lets one fatal dimension
 *    hide behind three good ones, which is exactly the failure this split exists
 *    to prevent.
 *  - **A missing dimension is not a pass.** An opinion that skipped a dimension
 *    contributes nothing to it; if no opinion scored a dimension at all, the
 *    dimension is unknown and autonomous publishing is refused.
 */

import type { SettlementMode } from "@/lib/market-modes";

export const PREFLIGHT_DIMENSIONS = [
  "resolutionClarity",
  "sourceIndependence",
  "liquidityFit",
  "bestMode",
] as const;
export type PreflightDimension = (typeof PREFLIGHT_DIMENSIONS)[number];

export function isPreflightDimension(value: string): value is PreflightDimension {
  return (PREFLIGHT_DIMENSIONS as readonly string[]).includes(value);
}

/** One persona's scores. Any dimension may be omitted — an abstention. */
export interface DimensionOpinion {
  slug: string;
  scores: Partial<Record<PreflightDimension, number>>;
  /** The mode this persona thinks the market should use, if it has a view. */
  suggestedMode?: SettlementMode;
  /** 0..100. Weights the persona's scores within each dimension. */
  confidence: number;
}

export interface DimensionSummary {
  dimension: PreflightDimension;
  /** Confidence-weighted mean, or null when nobody scored it. */
  score: number | null;
  voters: number;
  /** Below the dimension's own floor. */
  failing: boolean;
}

export interface PreflightVerdict {
  dimensions: Record<PreflightDimension, DimensionSummary>;
  /** The MINIMUM scored dimension. Null when any dimension is unscored. */
  aggregate: number | null;
  /** Dimensions nobody scored. */
  unscored: PreflightDimension[];
  /** Dimensions below their floor. */
  failing: PreflightDimension[];
  /** Mode the panel favours, when a majority of those with a view agree. */
  suggestedMode: SettlementMode | null;
  /** True when the panel disagrees about the mode with no majority. */
  modeContested: boolean;
  /** Safe to open without human review. */
  autonomousOk: boolean;
  /** One line naming the blocker, for the proposal record. */
  blockedBy?: string;
}

/**
 * Per-dimension floors.
 *
 * Resolution clarity is the strictest: an ambiguous rule produces a dispute no
 * amount of good sourcing repairs, and it is the one failure that ends with
 * somebody's money returned late or wrongly.
 */
export const DIMENSION_FLOORS: Record<PreflightDimension, number> = {
  resolutionClarity: 70,
  sourceIndependence: 60,
  liquidityFit: 50,
  bestMode: 50,
};

function clamp100(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function summarise(
  dimension: PreflightDimension,
  opinions: DimensionOpinion[],
): DimensionSummary {
  let weighted = 0;
  let weight = 0;
  let voters = 0;

  for (const opinion of opinions) {
    const raw = opinion.scores[dimension];
    if (typeof raw !== "number" || !Number.isFinite(raw)) continue;
    voters += 1;
    // A zero-confidence opinion still counts as a voter but carries no weight;
    // dropping it entirely would make "everyone scored it, nobody was sure" look
    // identical to "nobody looked".
    const w = clamp100(opinion.confidence);
    weighted += clamp100(raw) * w;
    weight += w;
  }

  if (voters === 0) {
    return { dimension, score: null, voters: 0, failing: false };
  }
  // All voters at zero confidence: fall back to an unweighted mean rather than
  // dividing by zero.
  const score =
    weight > 0
      ? weighted / weight
      : opinions.reduce((sum, o) => sum + clamp100(o.scores[dimension] ?? 0), 0) / voters;

  return {
    dimension,
    score: Math.round(score),
    voters,
    failing: Math.round(score) < DIMENSION_FLOORS[dimension],
  };
}

/**
 * The mode the panel favours.
 *
 * Requires a strict majority of the personas that expressed a view. A plurality is
 * not enough: opening a market in a mode most of the panel did not pick is how a
 * fixed-odds market gets created because three personas wanted three things.
 */
function resolveMode(opinions: DimensionOpinion[]): {
  suggestedMode: SettlementMode | null;
  modeContested: boolean;
} {
  const votes = new Map<SettlementMode, number>();
  let total = 0;
  for (const opinion of opinions) {
    if (!opinion.suggestedMode) continue;
    total += 1;
    votes.set(opinion.suggestedMode, (votes.get(opinion.suggestedMode) ?? 0) + 1);
  }
  if (total === 0) return { suggestedMode: null, modeContested: false };

  // Sorted by count then name, so a tie resolves identically on every run instead
  // of depending on Map insertion order.
  const ranked = [...votes.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const [mode, count] = ranked[0];
  if (count * 2 > total) return { suggestedMode: mode, modeContested: false };
  return { suggestedMode: null, modeContested: true };
}

export function scorePreflight(
  opinions: DimensionOpinion[],
  requestedMode?: SettlementMode,
): PreflightVerdict {
  const dimensions = Object.fromEntries(
    PREFLIGHT_DIMENSIONS.map((dimension) => [dimension, summarise(dimension, opinions)]),
  ) as Record<PreflightDimension, DimensionSummary>;

  const unscored = PREFLIGHT_DIMENSIONS.filter((d) => dimensions[d].score === null);
  const failing = PREFLIGHT_DIMENSIONS.filter((d) => dimensions[d].failing);
  const { suggestedMode, modeContested } = resolveMode(opinions);

  // The minimum, not the mean: a market nobody can settle is not rescued by
  // excellent sources.
  const aggregate =
    unscored.length > 0
      ? null
      : Math.min(...PREFLIGHT_DIMENSIONS.map((d) => dimensions[d].score as number));

  const blockedBy =
    opinions.length === 0
      ? "no preflight opinions"
      : unscored.length > 0
        ? `unscored: ${unscored.join(", ")}`
        : failing.length > 0
          ? `below floor: ${failing.map(d => `${d} (score ${dimensions[d].score} < ${DIMENSION_FLOORS[d]} floor)`).join(", ")}`
          : modeContested
            ? "panel disagrees about the settlement mode"
            : requestedMode && suggestedMode && requestedMode !== suggestedMode
              ? `panel prefers ${suggestedMode} over the requested ${requestedMode}`
              : undefined;

  return {
    dimensions,
    aggregate,
    unscored,
    failing,
    suggestedMode,
    modeContested,
    autonomousOk: blockedBy === undefined,
    blockedBy,
  };
}

/**
 * Did the panel report named dimensions at all?
 *
 * Matters during rollout: a fleet of personas that has not been updated returns
 * only a blended score, and treating that as "all four dimensions failed" would
 * silently stop market creation entirely. A caller uses this to fall back to the
 * old gate and SAY that it did, rather than either failing open or going quiet.
 */
export function dimensionsReported(verdict: PreflightVerdict): boolean {
  return verdict.unscored.length < PREFLIGHT_DIMENSIONS.length;
}
