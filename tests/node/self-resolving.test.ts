import assert from "node:assert/strict";
import test from "node:test";

import {
  Q_PRIOR,
  BONUS_DUST_USDC,
  verdictToProbability,
  crossEntropyScore,
  scoreCouncilVotes,
  allocateBonus,
  allocateBonusAtomic,
  payCouncilBonuses,
  parseCouncilBonusPool,
  isConfirmedCouncilSettlement,
  type CouncilVote,
} from "../../agents/oracle/council-vote";

// ── verdictToProbability ──────────────────────────────────────────────────────

test("confidence maps symmetrically around the prior", () => {
  assert.equal(verdictToProbability("CHALLENGERS_WIN", 80, Q_PRIOR), 0.9);
  assert.equal(verdictToProbability("CREATOR_WINS", 80, Q_PRIOR), 0.1);
  assert.equal(verdictToProbability("CHALLENGERS_WIN", 0, Q_PRIOR), 0.5);
});

test("q is clamped away from 0 and 1 so log scores stay finite", () => {
  assert.equal(verdictToProbability("CHALLENGERS_WIN", 100, Q_PRIOR), 0.98);
  assert.equal(verdictToProbability("CREATOR_WINS", 100, Q_PRIOR), 0.02);
  assert.equal(verdictToProbability("CHALLENGERS_WIN", 250, Q_PRIOR), 0.98);
});

test("DRAW and UNRESOLVABLE carry no information — q stays at qPrev", () => {
  assert.equal(verdictToProbability("DRAW", 90, 0.7), 0.7);
  assert.equal(verdictToProbability("UNRESOLVABLE", 90, 0.3), 0.3);
});

// ── crossEntropyScore ─────────────────────────────────────────────────────────

test("no update scores exactly zero — parroting the prior pays nothing", () => {
  assert.equal(crossEntropyScore(0.9, 0.5, 0.5), 0);
});

test("updates toward the reference score positive, away score negative", () => {
  assert.ok(crossEntropyScore(0.9, 0.8, 0.5) > 0);
  assert.ok(crossEntropyScore(0.9, 0.2, 0.5) < 0);
  // Mirror case: reference favors the creator.
  assert.ok(crossEntropyScore(0.1, 0.2, 0.5) > 0);
  assert.ok(crossEntropyScore(0.1, 0.8, 0.5) < 0);
});

test("reporting the reference belief itself maximizes the score", () => {
  const qT = 0.85;
  const atReference = crossEntropyScore(qT, qT, 0.5);
  for (const q of [0.55, 0.65, 0.75, 0.95]) {
    assert.ok(atReference > crossEntropyScore(qT, q, 0.5));
  }
});

test("scores are additive along the chain (market scoring rule telescopes)", () => {
  // Two sequential jurors moving 0.5→0.7→0.9 together earn what one juror
  // moving 0.5→0.9 would — payment splits by marginal contribution.
  const qT = 0.9;
  const combined = crossEntropyScore(qT, 0.7, 0.5) + crossEntropyScore(qT, 0.9, 0.7);
  const direct = crossEntropyScore(qT, 0.9, 0.5);
  assert.ok(Math.abs(combined - direct) < 1e-12);
});

// ── scoreCouncilVotes ─────────────────────────────────────────────────────────

function makeVote(overrides: Partial<CouncilVote>): CouncilVote {
  return {
    slug: "optimist",
    displayName: "The Optimist",
    verdict: "CHALLENGERS_WIN",
    confidence: 80,
    pricePaidUnits: null,
    ...overrides,
  };
}

test("scoreCouncilVotes chains q from the prior and skips abstainers", () => {
  const votes = [
    makeVote({ slug: "a", probability: 0.8 }),
    makeVote({ slug: "b", probability: undefined }), // abstained — no q
    makeVote({ slug: "c", probability: 0.9 }),
  ];
  const scored = scoreCouncilVotes(votes, 0.9);
  assert.ok(scored[0].score! > 0);              // 0.5 → 0.8 toward reference
  assert.equal(scored[1].score, 0);             // abstainer scores zero
  assert.ok(scored[2].score! > 0);              // 0.8 → 0.9, chain skipped b
  const direct = crossEntropyScore(0.9, 0.9, 0.8);
  assert.ok(Math.abs(scored[2].score! - direct) < 1e-12);
});

// ── allocateBonus ─────────────────────────────────────────────────────────────

test("bonus splits proportionally across positive scores only", () => {
  const bonuses = allocateBonus([0.3, 0.1, -0.5, 0], 0.008);
  assert.equal(bonuses[0], 0.006);
  assert.equal(bonuses[1], 0.002);
  assert.equal(bonuses[2], 0);
  assert.equal(bonuses[3], 0);
});

test("total payout never exceeds the pool", () => {
  const bonuses = allocateBonus([1.7, 0.9, 0.4], 0.01);
  const total = bonuses.reduce((a, b) => a + b, 0);
  assert.ok(total <= 0.01 + 1e-9);
});

test("dust shares are skipped, all-negative rounds pay nothing", () => {
  // 1% of the pool is below the dust floor.
  const bonuses = allocateBonus([99, 1], 0.01);
  assert.ok(bonuses[0] > 0);
  assert.equal(bonuses[1], 0);
  assert.ok((0.01 * 1) / 100 < BONUS_DUST_USDC);
  assert.deepEqual(allocateBonus([-1, -2, 0], 0.01), [0, 0, 0]);
});

test("atomic bonus allocation rounds down at seven decimals and rejects malformed scores", () => {
  const shares = allocateBonusAtomic([0.3, 0.1, -0.2], 80_001n);
  assert.deepEqual(shares, [60_000n, 20_000n, 0n]);
  assert.equal(shares.reduce((a, b) => a + b, 0n), 80_000n);
  assert.deepEqual(allocateBonusAtomic([99, 1], 10_000n), [9_900n, 0n]);
  assert.throws(() => allocateBonusAtomic([Number.NaN], 10_000n), /invalid council score/);
  assert.throws(() => allocateBonusAtomic([1], -1n), /non-negative/);
});

test("bonus configuration is exact, bounded and can pause payouts", () => {
  assert.equal(parseCouncilBonusPool("0"), 0n);
  assert.equal(parseCouncilBonusPool("0.01"), 100_000n);
  assert.equal(parseCouncilBonusPool("1"), 10_000_000n);
  assert.throws(() => parseCouncilBonusPool("1.0000001"), /safety limit/);
  assert.throws(() => parseCouncilBonusPool("0.00000001"), /Invalid USDC amount/);
  assert.throws(() => parseCouncilBonusPool("NaN"), /Invalid USDC amount/);
});

test("only a confirmed matching on-chain settlement releases bonuses", () => {
  const claim = { state: "resolved" as const, winner_side: "creator" as const,
    evidence_hash: "a".repeat(64) };
  assert.equal(isConfirmedCouncilSettlement(claim, "creator", "a".repeat(64), false), true);
  assert.equal(isConfirmedCouncilSettlement(claim, "creator", "a".repeat(64), true), false);
  assert.equal(isConfirmedCouncilSettlement({ ...claim, state: "cancelled" as const }, "creator", "a".repeat(64), false), false);
  assert.equal(isConfirmedCouncilSettlement(claim, "challengers", "a".repeat(64), false), false);
  assert.equal(isConfirmedCouncilSettlement(claim, "creator", "b".repeat(64), false), false);
  assert.equal(isConfirmedCouncilSettlement(null, "creator", "a".repeat(64), false), false);
});

test("bonus payouts bind recipients and reserve before sending; duplicate runs do not resend", async () => {
  const sent: string[] = [];
  const recorded: Array<string | null> = [];
  const reserved = new Set<string>();
  const wallet = { address: "oracle" } as Parameters<typeof payCouncilBonuses>[0]["payerWallet"];
  const votes = [
    makeVote({ slug: "a", score: 0.3, walletAddress: "juror-a", pricePaidUnits: "10000" }),
    makeVote({ slug: "b", score: 0.1, walletAddress: "untrusted", pricePaidUnits: "10000" }),
  ];
  const deps: NonNullable<Parameters<typeof payCouncilBonuses>[1]> = {
    addressFor: (slug) => `juror-${slug}`,
    balance: async () => 80_000n,
    reserve: async (row) => {
      if (reserved.has(row.jurorSlug)) return false;
      reserved.add(row.jurorSlug);
      return true;
    },
    record: async (_key, hash) => { recorded.push(hash); },
    transfer: async ({ amountUsdc }) => { sent.push(amountUsdc); return "a".repeat(64); },
  };
  const args = { votes, poolAtomic: 80_000n, payerWallet: wallet,
    claimId: 1, contractId: "contract", settlementTxHash: "b".repeat(64) };
  const first = await payCouncilBonuses(args, deps);
  assert.deepEqual(first.map((r) => r.status), ["paid"]);
  assert.deepEqual(sent, ["0.006"]);
  assert.deepEqual(recorded, ["a".repeat(64)]);
  const second = await payCouncilBonuses(args, deps);
  assert.deepEqual(second.map((r) => r.status), ["skipped"]);
  assert.equal(sent.length, 1);
});

test("missing funds, duplicate jurors and ambiguous transfers fail closed", async () => {
  const wallet = { address: "oracle" } as Parameters<typeof payCouncilBonuses>[0]["payerWallet"];
  const vote = makeVote({ slug: "a", score: 1, walletAddress: "juror-a", pricePaidUnits: "10000" });
  let transfers = 0;
  let reserved = false;
  let recorded: string | null | undefined;
  const deps: NonNullable<Parameters<typeof payCouncilBonuses>[1]> = {
    addressFor: () => "juror-a",
    balance: async () => 0n,
    reserve: async () => { if (reserved) return false; reserved = true; return true; },
    record: async (_key, hash) => { recorded = hash; },
    transfer: async () => { transfers++; throw new Error("private RPC failure"); },
  };
  const args = { votes: [vote], poolAtomic: 10_000n, payerWallet: wallet,
    claimId: 1, contractId: "contract", settlementTxHash: "b".repeat(64) };
  await assert.rejects(payCouncilBonuses(args, deps), /insufficient council bonus funds/);
  await assert.rejects(payCouncilBonuses({ ...args, votes: [vote, vote] }, deps), /duplicate council juror/);
  assert.equal(transfers, 0);
  deps.balance = async () => 10_000n;
  deps.reserve = async () => { throw new Error("database unavailable"); };
  await assert.rejects(payCouncilBonuses(args, deps), /database unavailable/);
  assert.equal(transfers, 0);
  deps.reserve = async () => { if (reserved) return false; reserved = true; return true; };
  assert.deepEqual((await payCouncilBonuses(args, deps)).map((r) => r.status), ["review"]);
  assert.equal(recorded, null);
  assert.deepEqual((await payCouncilBonuses(args, deps)).map((r) => r.status), ["skipped"]);
  assert.equal(transfers, 1);
});
