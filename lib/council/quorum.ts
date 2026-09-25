/**
 * Council quorum + fallback rules for settlement (§agents / RFB council boundary).
 *
 * `gatherCouncilVerdict` buys persona votes and tallies them. This module is the
 * pure policy layer that decides whether that tally is allowed to settle a claim,
 * or whether the oracle must fall back to its own (solo) verdict — and what to do
 * when a vote is invalid, stale, duplicated, cancelled, or a dependency failure.
 *
 * Chain remains source of truth: a cancelled or already-resolved claim never
 * produces a council settlement from this path. Below-quorum and dependency
 * failures degrade to solo oracle settlement rather than inventing a majority.
 *
 * Pure: no I/O. Callers classify each attempt, then ask {@link evaluateQuorum}.
 */

import { isVerdict, type Verdict } from "../verdict";

/** Claim lifecycle states the quorum gate cares about. */
export type ClaimSettleState = "open" | "active" | "resolved" | "cancelled";

/**
 * What happened to one persona vote attempt before it may enter the ballot.
 *
 * - **valid** — well-formed verdict for the claim being settled; may be decisive
 *   or an explicit abstention (DRAW / UNRESOLVABLE).
 * - **invalid** — malformed slug/verdict/body; never counts.
 * - **stale** — wrong claim id, already-resolved claim, or aged past maxAgeMs.
 * - **duplicated** — same persona already accepted onto this ballot.
 * - **cancelled** — claim is cancelled; council must not settle it.
 * - **dependency_failure** — network / timeout / 5xx; treated as abstention for
 *   tally purposes but recorded so fallback reasons stay auditable.
 */
export type VoteDisposition =
  | "valid"
  | "invalid"
  | "stale"
  | "duplicated"
  | "cancelled"
  | "dependency_failure";

export type FallbackAction =
  /** Decisive votes met quorum — use the council tally. */
  | "use_council"
  /** Not enough decisive votes (or only dependency failures) — oracle settles solo. */
  | "fallback_solo"
  /** Claim cancelled on-chain — do not settle via council or invent a solo win. */
  | "abort_cancelled"
  /** Claim already resolved — a new council pass would be stale. */
  | "abort_resolved"
  /** Quorum config is unusable after normalization refusal. */
  | "abort_invalid_config";

export interface QuorumConfig {
  /**
   * Minimum decisive (CREATOR_WINS | CHALLENGERS_WIN) votes required to trust
   * the council. Defaults to {@link DEFAULT_COUNCIL_QUORUM}.
   */
  quorum: number;
}

/** Default matches `COUNCIL_QUORUM` / oracle worker env. */
export const DEFAULT_COUNCIL_QUORUM = 3;

/** Hard ceiling so a typo cannot demand more jurors than exist. */
export const MAX_COUNCIL_QUORUM = 20;

export interface VoteAttemptInput {
  slug: string;
  /** Claim id the response claims to be about (from body or request). */
  claimId: number;
  /** Claim id the oracle is currently settling. */
  expectedClaimId: number;
  claimState: ClaimSettleState;
  /**
   * Transport outcome before JSON validation.
   * - `ok` — HTTP 2xx with a body to inspect
   * - `http_error` — non-2xx (see httpStatus)
   * - `network_error` / `timeout` — dependency failure
   */
  status: "ok" | "http_error" | "network_error" | "timeout";
  httpStatus?: number;
  verdict?: unknown;
  confidence?: unknown;
  /** Age of the response when known (ms). */
  ageMs?: number;
  /** Responses older than this are stale (optional). */
  maxAgeMs?: number;
}

export interface ClassifiedVote {
  slug: string;
  disposition: VoteDisposition;
  reason: string;
  verdict?: Verdict;
  confidence?: number;
  /** True when disposition is valid and verdict is CREATOR_WINS or CHALLENGERS_WIN. */
  decisive: boolean;
}

export interface QuorumEvaluation {
  action: FallbackAction;
  quorum: number;
  decisiveCount: number;
  acceptedCount: number;
  dispositions: Record<VoteDisposition, number>;
  reason: string;
  acceptedSlugs: string[];
  /** Valid votes in ballot order (duplicates / rejects excluded). */
  ballot: ClassifiedVote[];
}

const EMPTY_DISPOSITIONS = (): Record<VoteDisposition, number> => ({
  valid: 0,
  invalid: 0,
  stale: 0,
  duplicated: 0,
  cancelled: 0,
  dependency_failure: 0,
});

export function isDecisiveVerdict(verdict: Verdict): boolean {
  return verdict === "CREATOR_WINS" || verdict === "CHALLENGERS_WIN";
}

/**
 * Normalize a raw quorum (env Number, caller override, …).
 *
 * Invalid values (NaN, non-finite, &lt; 1) become the default so a typo cannot
 * silently disable the gate (`quorum: 0` would otherwise accept an empty jury).
 * Values above {@link MAX_COUNCIL_QUORUM} clamp rather than reject — demanding
 * more jurors than the roster has is a config smell, not a settle-time abort.
 */
export function normalizeQuorum(raw: unknown, fallback = DEFAULT_COUNCIL_QUORUM): number {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN;
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(MAX_COUNCIL_QUORUM, Math.trunc(n));
}

/**
 * True when the raw value was unusable (callers that want strict refusal can
 * abort instead of normalizing). Empty / missing is not invalid — it means default.
 */
export function isInvalidQuorumConfig(raw: unknown): boolean {
  if (raw === undefined || raw === null || raw === "") return false;
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN;
  return !Number.isFinite(n) || n < 1;
}

function clampConfidence(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/**
 * Classify a single vote attempt. Duplicates are handled by
 * {@link buildBallot} so this function stays order-independent.
 */
export function classifyVoteAttempt(input: VoteAttemptInput): ClassifiedVote {
  const slug = (input.slug ?? "").trim().toLowerCase();
  if (!slug) {
    return {
      slug: "",
      disposition: "invalid",
      reason: "missing persona slug",
      decisive: false,
    };
  }

  if (input.claimState === "cancelled") {
    return {
      slug,
      disposition: "cancelled",
      reason: "claim is cancelled on-chain",
      decisive: false,
    };
  }

  if (input.claimState === "resolved") {
    return {
      slug,
      disposition: "stale",
      reason: "claim is already resolved",
      decisive: false,
    };
  }

  if (
    !Number.isInteger(input.expectedClaimId) ||
    input.expectedClaimId < 1 ||
    !Number.isInteger(input.claimId) ||
    input.claimId !== input.expectedClaimId
  ) {
    return {
      slug,
      disposition: "stale",
      reason: `vote claimId ${input.claimId} does not match settling claim ${input.expectedClaimId}`,
      decisive: false,
    };
  }

  if (
    input.maxAgeMs != null &&
    Number.isFinite(input.maxAgeMs) &&
    input.maxAgeMs >= 0 &&
    input.ageMs != null &&
    Number.isFinite(input.ageMs) &&
    input.ageMs > input.maxAgeMs
  ) {
    return {
      slug,
      disposition: "stale",
      reason: `vote age ${input.ageMs}ms exceeds maxAgeMs ${input.maxAgeMs}`,
      decisive: false,
    };
  }

  if (input.status === "network_error" || input.status === "timeout") {
    return {
      slug,
      disposition: "dependency_failure",
      reason: input.status === "timeout" ? "vote request timed out" : "vote request network failure",
      decisive: false,
    };
  }

  if (input.status === "http_error") {
    const code = input.httpStatus ?? 0;
    // 5xx / 502-style upstream failures are dependency problems; 4xx are invalid
    // requests or persona/policy refusals — not something retrying the roster fixes.
    if (code >= 500 || code === 0) {
      return {
        slug,
        disposition: "dependency_failure",
        reason: `vote endpoint HTTP ${code || "error"}`,
        decisive: false,
      };
    }
    if (code === 404) {
      return {
        slug,
        disposition: "stale",
        reason: "claim not found at vote endpoint",
        decisive: false,
      };
    }
    return {
      slug,
      disposition: "invalid",
      reason: `vote endpoint HTTP ${code}`,
      decisive: false,
    };
  }

  if (!isVerdict(input.verdict)) {
    return {
      slug,
      disposition: "invalid",
      reason: "missing or unknown verdict",
      decisive: false,
    };
  }

  const confidence = clampConfidence(input.confidence);
  return {
    slug,
    disposition: "valid",
    reason: "accepted",
    verdict: input.verdict,
    confidence,
    decisive: isDecisiveVerdict(input.verdict),
  };
}

/**
 * Fold classified attempts into a ballot: first valid vote per slug wins;
 * later attempts for the same slug are marked duplicated and dropped.
 */
export function buildBallot(classified: ClassifiedVote[]): {
  ballot: ClassifiedVote[];
  rejected: ClassifiedVote[];
} {
  const seen = new Set<string>();
  const ballot: ClassifiedVote[] = [];
  const rejected: ClassifiedVote[] = [];

  for (const vote of classified) {
    if (vote.disposition !== "valid") {
      rejected.push(vote);
      continue;
    }
    if (seen.has(vote.slug)) {
      rejected.push({
        ...vote,
        disposition: "duplicated",
        reason: `duplicate vote for persona '${vote.slug}'`,
        decisive: false,
        verdict: undefined,
        confidence: undefined,
      });
      continue;
    }
    seen.add(vote.slug);
    ballot.push(vote);
  }

  return { ballot, rejected };
}

function countDispositions(
  votes: ClassifiedVote[],
): Record<VoteDisposition, number> {
  const counts = EMPTY_DISPOSITIONS();
  for (const vote of votes) counts[vote.disposition] += 1;
  return counts;
}

/**
 * Decide whether the council ballot may settle the claim, or how to fall back.
 *
 * @param strictConfig — when set and {@link isInvalidQuorumConfig} is true,
 *   returns `abort_invalid_config` instead of normalizing.
 */
export function evaluateQuorum(
  attempts: ClassifiedVote[],
  quorumRaw: unknown = DEFAULT_COUNCIL_QUORUM,
  opts?: {
    claimState?: ClaimSettleState;
    strictConfig?: boolean;
  },
): QuorumEvaluation {
  const claimState = opts?.claimState;

  if (claimState === "cancelled") {
    return {
      action: "abort_cancelled",
      quorum: normalizeQuorum(quorumRaw),
      decisiveCount: 0,
      acceptedCount: 0,
      dispositions: countDispositions(attempts),
      reason: "claim is cancelled — council settlement aborted",
      acceptedSlugs: [],
      ballot: [],
    };
  }

  if (claimState === "resolved") {
    return {
      action: "abort_resolved",
      quorum: normalizeQuorum(quorumRaw),
      decisiveCount: 0,
      acceptedCount: 0,
      dispositions: countDispositions(attempts),
      reason: "claim is already resolved — council pass is stale",
      acceptedSlugs: [],
      ballot: [],
    };
  }

  if (opts?.strictConfig && isInvalidQuorumConfig(quorumRaw)) {
    return {
      action: "abort_invalid_config",
      quorum: 0,
      decisiveCount: 0,
      acceptedCount: 0,
      dispositions: countDispositions(attempts),
      reason: `invalid COUNCIL_QUORUM value: ${String(quorumRaw)}`,
      acceptedSlugs: [],
      ballot: [],
    };
  }

  const quorum = normalizeQuorum(quorumRaw);
  const { ballot, rejected } = buildBallot(attempts);
  const all = [...ballot, ...rejected];
  const dispositions = countDispositions(all);
  const decisiveCount = ballot.filter((v) => v.decisive).length;
  const acceptedSlugs = ballot.map((v) => v.slug);

  if (decisiveCount >= quorum) {
    return {
      action: "use_council",
      quorum,
      decisiveCount,
      acceptedCount: ballot.length,
      dispositions,
      reason: `quorum met: ${decisiveCount} decisive ≥ ${quorum}`,
      acceptedSlugs,
      ballot,
    };
  }

  const dep = dispositions.dependency_failure;
  const reasonParts = [
    `below quorum: ${decisiveCount} decisive < ${quorum}`,
    dispositions.invalid ? `${dispositions.invalid} invalid` : null,
    dispositions.stale ? `${dispositions.stale} stale` : null,
    dispositions.duplicated ? `${dispositions.duplicated} duplicated` : null,
    dep ? `${dep} dependency_failure` : null,
  ].filter(Boolean);

  return {
    action: "fallback_solo",
    quorum,
    decisiveCount,
    acceptedCount: ballot.length,
    dispositions,
    reason: reasonParts.join("; "),
    acceptedSlugs,
    ballot,
  };
}

/** True when the oracle should settle with its own evidence (not abort). */
export function shouldFallbackSolo(evaluation: QuorumEvaluation): boolean {
  return evaluation.action === "fallback_solo";
}

/** True when council tally is authoritative for this settlement. */
export function shouldUseCouncil(evaluation: QuorumEvaluation): boolean {
  return evaluation.action === "use_council";
}
