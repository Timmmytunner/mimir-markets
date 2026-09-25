/**
 * Council-as-jury for settlement.
 *
 * During settlement the oracle BUYS each eligible persona's verdict via a USDC
 * payment (into the persona's own wallet through the paid /api/council/vote
 * endpoint), then tallies the votes into the on-chain verdict.
 * This is what binds the 10 personas to settlement: every juror is paid, and
 * the consensus — not a single oracle call — decides the payout.
 *
 * Best-effort: any persona that errors or times out is a dependency_failure
 * abstention (see `lib/council/quorum.ts`). Invalid, stale, duplicated, and
 * cancelled votes never pad the jury. If fewer than `quorum` decisive votes
 * remain, returns null so the caller falls back to its own (solo) verdict —
 * council voting never blocks a settlement of an open/active claim.
 *
 * Self-resolving mode (opt-in via `selfResolving` config) implements the
 * mechanism from "Self-Resolving Prediction Markets for Unverifiable Outcomes"
 * (Srinivasan, Karger, Chen — arXiv:2306.04305): jurors report sequentially in
 * random order, each seeing the prior reports; the market stops with
 * probability alpha after each vote; and jurors are later scored with a
 * cross-entropy market scoring rule against the terminal (reference) report —
 * the oracle's own history-informed assessment. Informative updates toward the
 * reference earn a bonus, parroting the prior earns exactly zero.
 */

import { listCouncilPersonas, type PersonaSpec } from "../council/personas";
import { fetchWithBudget, type PayingWallet } from "../../lib/x402/buyer";
import { getCouncilAddress, transferUsdc, type AgentWallet } from "../../lib/agent-wallets";
import { getUsdcBalanceUnits, formatAtomicUsdc, parseUsdcAtomic, USDC_UNIT } from "../../lib/usdc";
import { STELLAR_NETWORK } from "../../lib/stellar";
import { reserveCouncilBonus, recordCouncilBonusResult } from "../../lib/council-bonus-ledger";
import type { ClaimData } from "../../lib/contract";
import { usdcToUnits } from "../../lib/usdc";
import type { Verdict } from "../../lib/verdict";
import {
  classifyVoteAttempt,
  evaluateQuorum,
  normalizeQuorum,
  type ClaimSettleState,
  type ClassifiedVote,
} from "../../lib/council/quorum";

export type { Verdict };

export interface CouncilVote {
  slug: string;
  displayName: string;
  verdict: Verdict;
  confidence: number;
  pricePaidUnits: string | null; // USDC atomic units (7dp), null if free/unsettled
  /** Persona wallet that received the vote fee (bonus transfer target). */
  walletAddress?: string;
  /** q_t = P(CHALLENGERS_WIN) implied by this report (self-resolving mode). */
  probability?: number;
  /** Cross-entropy score vs the terminal reference report (self-resolving mode). */
  score?: number;
  /** Bonus paid out for a positive score (self-resolving mode). */
  bonusUsdc?: number;
}

export interface CouncilVerdict {
  verdict: Verdict;
  confidence: number;
  explanation: string;
  tally: { creator: number; challengers: number; draw: number; unresolvable: number; decisive: number };
  votes: CouncilVote[];
  totalPaidUnits: bigint;
  /** Sequential q_t reports, prior first implicit at Q_PRIOR (self-resolving mode). */
  qHistory?: number[];
  /** Human-readable juror reports, in voting order — fed to the terminal
   *  (reference) assessment (self-resolving mode). */
  reports?: string[];
}

export interface SelfResolvingConfig {
  /** Stop probability after each vote once `minVotes` decisive reports exist. */
  alpha: number;
  /** Decisive reports required before random termination may trigger. */
  minVotes: number;
}

// ── Self-resolving mechanism math (pure, unit-tested) ─────────────────────────

/** Common prior. The on-chain pool ratio would be the natural prior but is
 *  manipulable by the creator's own stake, so we start neutral. */
export const Q_PRIOR = 0.5;
// Keep q away from {0,1} so the log scores stay finite.
const Q_MIN = 0.02;
const Q_MAX = 0.98;
/** Bonus shares below this are dust — skipped rather than transferred. */
export const BONUS_DUST_USDC = 0.0005;

function clampQ(q: number): number {
  // Round to 4dp so float artifacts (0.5 − 80/200 = 0.09999…8) don't leak
  // into logs, commits, and score math.
  const rounded = Math.round(q * 1e4) / 1e4;
  return Math.min(Q_MAX, Math.max(Q_MIN, rounded));
}

/**
 * Maps a verdict+confidence report to q = P(CHALLENGERS_WIN).
 * DRAW/UNRESOLVABLE carry no directional information → q stays at qPrev,
 * which makes the report's cross-entropy score exactly zero.
 */
export function verdictToProbability(verdict: Verdict, confidence: number, qPrev: number): number {
  const c = Math.max(0, Math.min(100, confidence));
  if (verdict === "CHALLENGERS_WIN") return clampQ(0.5 + c / 200);
  if (verdict === "CREATOR_WINS") return clampQ(0.5 - c / 200);
  return qPrev;
}

/**
 * Cross-entropy market scoring rule: the juror's marginal information
 * contribution, judged by the terminal reference belief qT.
 *   S = qT·ln(qt/qPrev) + (1−qT)·ln((1−qt)/(1−qPrev))
 * Zero when qt === qPrev (no update); positive for updates toward qT.
 */
export function crossEntropyScore(qT: number, qt: number, qPrev: number): number {
  return qT * Math.log(qt / qPrev) + (1 - qT) * Math.log((1 - qt) / (1 - qPrev));
}

/**
 * Fills each vote's `score` from its q_t against the reference report.
 * The q chain starts at Q_PRIOR; abstaining reports (probability undefined)
 * score zero and do not advance the chain.
 */
export function scoreCouncilVotes(votes: CouncilVote[], referenceQ: number): CouncilVote[] {
  const qT = clampQ(referenceQ);
  let qPrev = Q_PRIOR;
  return votes.map((v) => {
    if (v.probability === undefined) return { ...v, score: 0 };
    const score = crossEntropyScore(qT, v.probability, qPrev);
    qPrev = v.probability;
    return { ...v, score };
  });
}

/**
 * Splits `poolUsdc` proportionally across positive scores; non-positive
 * scores and dust-sized shares get nothing. May under-distribute (dust is
 * kept, never redistributed) and never exceeds the pool.
 */
export function allocateBonus(scores: number[], poolUsdc: number): number[] {
  const positives = scores.map((s) => (s > 0 ? s : 0));
  const total = positives.reduce((a, b) => a + b, 0);
  if (total <= 0 || poolUsdc <= 0) return scores.map(() => 0);
  // Integer micro-USDC with a float-noise epsilon: floors guarantee the sum
  // never exceeds the pool.
  const poolMicro = Math.round(poolUsdc * 1e6);
  return positives.map((s) => {
    const shareMicro = Math.floor((poolMicro * s) / total + 1e-6);
    const share = shareMicro / 1e6;
    return share >= BONUS_DUST_USDC ? share : 0;
  });
}

/** Allocate exact seven-decimal Stellar USDC, always rounding down. */
export function allocateBonusAtomic(scores: number[], poolAtomic: bigint): bigint[] {
  if (poolAtomic < 0n) throw new Error("bonus pool must be non-negative");
  const weights = scores.map((score) => {
    if (!Number.isFinite(score) || Math.abs(score) > 100) throw new Error("invalid council score");
    return score > 0 ? BigInt(Math.floor(score * 1e12)) : 0n;
  });
  const total = weights.reduce((sum, weight) => sum + weight, 0n);
  if (total === 0n) return scores.map(() => 0n);
  const dustAtomic = 5_000n; // 0.0005 USDC
  return weights.map((weight) => {
    const share = (poolAtomic * weight) / total;
    return share >= dustAtomic ? share : 0n;
  });
}

export function parseCouncilBonusPool(input: string): bigint {
  const units = parseUsdcAtomic(input);
  if (units > USDC_UNIT) throw new Error("COUNCIL_BONUS_USDC exceeds the 1 USDC safety limit");
  return units;
}

export function isConfirmedCouncilSettlement(
  claim: Pick<ClaimData, "state" | "winner_side" | "evidence_hash"> | null,
  expectedSide: ClaimData["winner_side"],
  evidenceHash: string,
  pending: boolean,
): boolean {
  return !pending && claim?.state === "resolved" &&
    claim.winner_side === expectedSide &&
    claim.evidence_hash?.toLowerCase() === evidenceHash.toLowerCase();
}

/** Personas that can judge a claim: evidence-reasoning (have a promptBias) and,
 *  for specialists, only within their category. Rule-based traders abstain. */
function eligiblePersonas(category: string): PersonaSpec[] {
  const cat = category.toLowerCase();
  return listCouncilPersonas().filter(
    (p) =>
      !!p.promptBias &&
      (!p.categoryFilter || p.categoryFilter.some((c) => c.toLowerCase() === cat)),
  );
}

interface VoteResponse {
  verdict?: Verdict;
  confidence?: number;
  explanation?: string;
  paidTo?: string;
}

function shuffled<T>(items: T[]): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export async function gatherCouncilVerdict(args: {
  claimId: number;
  category: string;
  baseUrl: string;
  payer: PayingWallet;
  votePriceBot?: number;
  capUsdc?: number;
  quorum?: number;
  /**
   * On-chain claim lifecycle. Cancelled / already-resolved claims abort
   * before a council tally can override chain-as-source-of-truth.
   */
  claimState?: ClaimSettleState;
  /** Enables the sequential self-resolving mechanism (see module header). */
  selfResolving?: SelfResolvingConfig;
}): Promise<CouncilVerdict | null> {
  const capUnits = usdcToUnits(args.capUsdc ?? 0.005);
  const quorum = normalizeQuorum(args.quorum ?? 3);
  const claimState: ClaimSettleState = args.claimState ?? "active";
  // Cancelled / resolved claims never buy votes — chain already decided.
  if (claimState === "cancelled" || claimState === "resolved") {
    const gate = evaluateQuorum([], quorum, { claimState });
    console.warn(`[council] ${gate.reason}`);
    return null;
  }
  const sr = args.selfResolving;
  // Random order prevents the same persona from always reporting first
  // (uninformed) or last (most informed) — part of the mechanism's
  // resistance to juror position gaming.
  const personas = sr ? shuffled(eligiblePersonas(args.category)) : eligiblePersonas(args.category);
  if (personas.length === 0) return null;

  const votes: CouncilVote[] = [];
  const classified: ClassifiedVote[] = [];
  const seenSlugs = new Set<string>();
  const qHistory: number[] = [];
  const history: string[] = [];
  let qPrev = Q_PRIOR;
  let decisiveSoFar = 0;
  let totalPaidUnits = 0n;

  // Sequential: keeps within LLM free-tier RPM and RPC rate limits —
  // and in self-resolving mode, sequencing is the mechanism itself.
  for (const p of personas) {
    let url = `${args.baseUrl.replace(/\/$/, "")}/api/council/vote?claimId=${args.claimId}&persona=${encodeURIComponent(p.slug)}`;
    if (sr && history.length > 0) {
      url += `&history=${encodeURIComponent(JSON.stringify(history.slice(-8)))}`;
    }
    try {
      const r = await fetchWithBudget(url, args.payer, capUnits);
      if (!r.response.ok) {
        classified.push(
          classifyVoteAttempt({
            slug: p.slug,
            claimId: args.claimId,
            expectedClaimId: args.claimId,
            claimState,
            status: "http_error",
            httpStatus: r.response.status,
          }),
        );
        continue;
      }
      const body = (await r.response.json()) as VoteResponse;
      const bodyClaimId =
        typeof (body as { claimId?: unknown }).claimId === "number"
          ? (body as { claimId: number }).claimId
          : args.claimId;
      const classifiedVote = classifyVoteAttempt({
        slug: p.slug,
        claimId: bodyClaimId,
        expectedClaimId: args.claimId,
        claimState,
        status: "ok",
        verdict: body.verdict,
        confidence: body.confidence,
      });
      // First valid vote per slug wins; later ones are duplicated and dropped.
      if (classifiedVote.disposition === "valid" && seenSlugs.has(classifiedVote.slug)) {
        classified.push({
          ...classifiedVote,
          disposition: "duplicated",
          reason: `duplicate vote for persona '${classifiedVote.slug}'`,
          decisive: false,
          verdict: undefined,
          confidence: undefined,
        });
        continue;
      }
      if (classifiedVote.disposition !== "valid" || !classifiedVote.verdict) {
        classified.push(classifiedVote);
        continue;
      }
      const verdict = classifiedVote.verdict;
      const priceUnits = r.payment?.priceUnits ?? null;
      const expectedWallet = getCouncilAddress(p.slug);
      const rawConfidence = body.confidence;
      if (!expectedWallet || body.paidTo !== expectedWallet ||
          priceUnits === null || priceUnits <= 0n ||
          typeof rawConfidence !== "number" || !Number.isInteger(rawConfidence) ||
          rawConfidence < 0 || rawConfidence > 100) {
        // An HTTP response cannot nominate a different bonus recipient.
        classified.push({
          ...classifiedVote,
          disposition: "invalid",
          reason: "unverified payment, recipient, or confidence",
          decisive: false,
          verdict: undefined,
          confidence: undefined,
        });
        continue;
      }
      classified.push(classifiedVote);
      seenSlugs.add(classifiedVote.slug);
      totalPaidUnits += priceUnits;
      const confidence = rawConfidence;
      const vote: CouncilVote = {
        slug: p.slug,
        displayName: p.displayName,
        verdict,
        confidence,
        pricePaidUnits: priceUnits != null ? priceUnits.toString() : null,
        walletAddress: typeof body.paidTo === "string" ? body.paidTo : undefined,
      };
      if (sr) {
        const q = verdictToProbability(verdict, confidence, qPrev);
        vote.probability = q;
        qHistory.push(q);
        const reasoning = (body.explanation ?? "").slice(0, 220);
        history.push(
          `${p.displayName}: ${Math.round(q * 100)}% challengers — ${reasoning}`,
        );
        qPrev = q;
      }
      votes.push(vote);
      if (verdict === "CREATOR_WINS" || verdict === "CHALLENGERS_WIN") {
        decisiveSoFar++;
      }
      // Random termination: once enough decisive reports exist, each further
      // vote only happens with probability 1−alpha. Keeps the reference
      // report's position unpredictable and bounds LLM spend per settlement.
      if (sr && decisiveSoFar >= sr.minVotes && Math.random() < sr.alpha) {
        break;
      }
    } catch {
      // persona abstains on dependency failure — recorded for quorum audit
      classified.push(
        classifyVoteAttempt({
          slug: p.slug,
          claimId: args.claimId,
          expectedClaimId: args.claimId,
          claimState,
          status: "network_error",
        }),
      );
    }
  }

  const tally = { creator: 0, challengers: 0, draw: 0, unresolvable: 0, decisive: 0 };
  for (const v of votes) {
    if (v.verdict === "CREATOR_WINS") tally.creator++;
    else if (v.verdict === "CHALLENGERS_WIN") tally.challengers++;
    else if (v.verdict === "DRAW") tally.draw++;
    else tally.unresolvable++;
  }
  tally.decisive = tally.creator + tally.challengers;

  // Quorum + fallback policy: below quorum / dependency-heavy ballots → solo.
  const gate = evaluateQuorum(classified, quorum, { claimState });
  if (gate.action !== "use_council") {
    console.warn(`[council] ${gate.reason}`);
    return null;
  }

  let verdict: Verdict;
  let winningVotes: CouncilVote[];
  if (tally.creator > tally.challengers) {
    verdict = "CREATOR_WINS";
    winningVotes = votes.filter((v) => v.verdict === "CREATOR_WINS");
  } else if (tally.challengers > tally.creator) {
    verdict = "CHALLENGERS_WIN";
    winningVotes = votes.filter((v) => v.verdict === "CHALLENGERS_WIN");
  } else {
    // Split jury — refund rather than guess.
    verdict = "UNRESOLVABLE";
    winningVotes = [];
  }

  // Confidence = avg of the majority's confidence, scaled by how lopsided the
  // decisive vote was (a 7–1 majority is firmer than 4–3).
  const avgConf =
    winningVotes.length > 0
      ? winningVotes.reduce((s, v) => s + v.confidence, 0) / winningVotes.length
      : 0;
  const agreement = tally.decisive > 0 ? Math.max(tally.creator, tally.challengers) / tally.decisive : 0;
  const confidence = Math.round(avgConf * agreement);

  const side = verdict === "CREATOR_WINS" ? "CREATOR" : verdict === "CHALLENGERS_WIN" ? "CHALLENGERS" : "SPLIT";
  const abstain = tally.draw + tally.unresolvable;
  const explanation = `[council ${tally.creator}–${tally.challengers} → ${side}${abstain ? `, ${abstain} abstain` : ""}] ${winningVotes[0]?.displayName ?? "Jury"} et al.`.slice(0, 500);

  return {
    verdict,
    confidence,
    explanation,
    tally,
    votes,
    totalPaidUnits,
    ...(sr ? { qHistory, reports: history } : {}),
  };
}

export interface BonusReceipt {
  slug: string;
  amountAtomic: bigint;
  txHash: string | null;
  status: "paid" | "skipped" | "review";
}

/**
 * Pay confirmed council bonuses from the oracle's own wallet. Each classic
 * transfer is reserved durably before submission; an ambiguous outcome is
 * held for manual review rather than retried. Market settlement remains final
 * regardless of bonus-transfer failures.
 */
export async function payCouncilBonuses(args: {
  votes: CouncilVote[];
  poolAtomic: bigint;
  payerWallet: AgentWallet;
  claimId: number;
  contractId: string;
  settlementTxHash: string;
}, deps: {
  addressFor: typeof getCouncilAddress;
  balance: typeof getUsdcBalanceUnits;
  reserve: typeof reserveCouncilBonus;
  record: typeof recordCouncilBonusResult;
  transfer: typeof transferUsdc;
} = {
  addressFor: getCouncilAddress,
  balance: getUsdcBalanceUnits,
  reserve: reserveCouncilBonus,
  record: recordCouncilBonusResult,
  transfer: transferUsdc,
}): Promise<BonusReceipt[]> {
  if (!Number.isSafeInteger(args.claimId) || args.claimId < 1 ||
      !/^[0-9a-fA-F]{64}$/.test(args.settlementTxHash)) {
    throw new Error("invalid bonus settlement identity");
  }
  const seen = new Set<string>();
  for (const vote of args.votes) {
    if (seen.has(vote.slug)) throw new Error("duplicate council juror");
    seen.add(vote.slug);
  }
  const bonuses = allocateBonusAtomic(args.votes.map((v) => v.score ?? 0), args.poolAtomic);
  const eligible = args.votes.map((vote, index) => ({ vote, amount: bonuses[index] }))
    .filter(({ vote, amount }) => amount > 0n &&
      typeof vote.pricePaidUnits === "string" && /^[1-9][0-9]*$/.test(vote.pricePaidUnits) &&
      typeof vote.walletAddress === "string" && vote.walletAddress.length > 0 &&
      vote.walletAddress === deps.addressFor(vote.slug));
  const total = eligible.reduce((sum, item) => sum + item.amount, 0n);
  if (total === 0n) return [];
  const balance = await deps.balance(args.payerWallet.address);
  if (balance === null || balance < total) throw new Error("insufficient council bonus funds");

  const receipts: BonusReceipt[] = [];
  for (const { vote, amount } of eligible) {
    const key = { network: STELLAR_NETWORK, contractId: args.contractId,
      claimId: args.claimId, jurorSlug: vote.slug };
    const reserved = await deps.reserve({ ...key, recipient: vote.walletAddress!,
      amountAtomic: amount, settlementTxHash: args.settlementTxHash });
    if (!reserved) {
      receipts.push({ slug: vote.slug, amountAtomic: amount, txHash: null, status: "skipped" });
      continue;
    }
    let txHash: string | null = null;
    try {
      txHash = await deps.transfer({
        wallet: args.payerWallet,
        to: vote.walletAddress!,
        amountUsdc: formatAtomicUsdc(amount),
      });
      if (!/^[0-9a-fA-F]{64}$/.test(txHash)) throw new Error("invalid payment transaction hash");
      await deps.record(key, txHash);
      vote.bonusUsdc = Number(amount) / 10_000_000;
      receipts.push({ slug: vote.slug, amountAtomic: amount, txHash, status: "paid" });
    } catch {
      if (!txHash) await deps.record(key, null).catch(() => undefined);
      receipts.push({ slug: vote.slug, amountAtomic: amount, txHash, status: "review" });
    }
  }
  return receipts;
}
