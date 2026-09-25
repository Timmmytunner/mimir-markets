import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_TOTAL_FEE_BPS,
  conservationHolds,
  isRefundOutcome,
  mergeAccruals,
  noWinnerLosesPrincipal,
  settleMarket,
  snapshotFeePolicy,
  splitFees,
  validateFeePolicy,
  type FeePolicy,
  type FeeSnapshot,
  type Participant,
  type SettlementOutcome,
} from "../../lib/fees";
import { poolChallengerPayoutUnits, poolCreatorPayoutUnits } from "../../lib/payout";
import { usdcToUnits } from "../../lib/usdc";

const U = usdcToUnits;
const PLATFORM = "0x1111111111111111111111111111111111111111";
const AGENT_OWNER = "0x2222222222222222222222222222222222222222";
const CREATOR = "0x000000000000000000000000000000000000000a";

function policy(overrides: Partial<FeePolicy> = {}): FeePolicy {
  return {
    platformFeeBps: 300, // 3% of profit
    agentOwnerFeeBps: 0,
    platformRecipient: PLATFORM,
    agentOwnerRecipient: null,
    ...overrides,
  };
}

function snapshot(overrides: Partial<FeeSnapshot> = {}): FeeSnapshot {
  return { ...snapshotFeePolicy(policy(), { at: 1_000 }), ...overrides };
}

// ── The invariant that dictates the fee base ───────────────────────────────────

test("a winner NEVER receives less than their principal", () => {
  // The crowded-pool case that makes charging on gross payout unacceptable: a
  // 10 USDC stake that wins 11 has only 1 of profit. A fee on the gross 11 would
  // hand the winner back less than they staked.
  const split = splitFees({
    principalUnits: U(10),
    grossPayoutUnits: U(11),
    // Deliberately the maximum permitted total fee.
    snapshot: snapshot({ platformFeeBps: 1_000 }),
    outcome: "challengers_win",
  });
  assert.ok(split.payoutUnits >= U(10), "a correct forecaster must not lose money");
  assert.equal(split.principalUnits, U(10));
  assert.equal(split.grossProfitUnits, U(1));
  assert.equal(split.platformFeeUnits, U(0.1));
  assert.equal(split.payoutUnits, U(10.9));
});

test("the fee base is profit, so it scales with what was actually won", () => {
  const thin = splitFees({
    principalUnits: U(10),
    grossPayoutUnits: U(11),
    snapshot: snapshot(),
    outcome: "challengers_win",
  });
  const fat = splitFees({
    principalUnits: U(10),
    grossPayoutUnits: U(110),
    snapshot: snapshot(),
    outcome: "creator_wins",
  });
  assert.equal(thin.platformFeeUnits, U(0.03));
  assert.equal(fat.platformFeeUnits, U(3));
});

test("a win with zero profit is charged nothing", () => {
  const split = splitFees({
    principalUnits: U(10),
    grossPayoutUnits: U(10),
    snapshot: snapshot(),
    outcome: "creator_wins",
  });
  assert.equal(split.grossProfitUnits, 0n);
  assert.equal(split.platformFeeUnits, 0n);
  assert.equal(split.payoutUnits, U(10));
});

test("a gross payout below principal cannot produce a negative profit", () => {
  const split = splitFees({
    principalUnits: U(10),
    grossPayoutUnits: U(4),
    snapshot: snapshot(),
    outcome: "challengers_win",
  });
  assert.equal(split.grossProfitUnits, 0n);
  assert.equal(split.platformFeeUnits, 0n);
});

// ── Refunds are untouched ─────────────────────────────────────────────────────

test("draws, unresolvable outcomes and cancellations are refunded in full", () => {
  // Taking a cut of a returned stake would make Mimir the only winner of an
  // ambiguous market.
  for (const outcome of ["draw", "unresolvable", "cancelled"] as SettlementOutcome[]) {
    assert.equal(isRefundOutcome(outcome), true);
    const split = splitFees({
      principalUnits: U(10),
      // Even if a gross payout is somehow supplied, a refund ignores it.
      grossPayoutUnits: U(100),
      snapshot: snapshot({ platformFeeBps: 1_000, agentOwnerFeeBps: 0 }),
      outcome,
    });
    assert.equal(split.payoutUnits, U(10), `${outcome} must refund in full`);
    assert.equal(split.platformFeeUnits, 0n);
    assert.equal(split.agentOwnerFeeUnits, 0n);
  }
});

test("decisive outcomes are not refund outcomes", () => {
  assert.equal(isRefundOutcome("creator_wins"), false);
  assert.equal(isRefundOutcome("challengers_win"), false);
});

// ── Policy validation and the cap ──────────────────────────────────────────────

test("a sane policy validates", () => {
  assert.deepEqual(validateFeePolicy(policy()), { ok: true, errors: [] });
});

test("the total fee cap cannot be exceeded", () => {
  // No admin action or bug may produce a market that eats a winner's profit.
  const result = validateFeePolicy(policy({ platformFeeBps: 600, agentOwnerFeeBps: 600 }));
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /exceeds the 1000 bps cap/);
  assert.equal(MAX_TOTAL_FEE_BPS, 1_000n);
});

test("the cap is on the SUM, so either fee alone may reach it", () => {
  assert.equal(validateFeePolicy(policy({ platformFeeBps: 1_000 })).ok, true);
  assert.equal(
    validateFeePolicy(
      policy({ platformFeeBps: 500, agentOwnerFeeBps: 500, agentOwnerRecipient: AGENT_OWNER }),
    ).ok,
    true,
  );
  assert.equal(validateFeePolicy(policy({ platformFeeBps: 1_001 })).ok, false);
});

test("negative and fractional basis points are refused", () => {
  assert.equal(validateFeePolicy(policy({ platformFeeBps: -1 })).ok, false);
  assert.equal(validateFeePolicy(policy({ platformFeeBps: 2.5 })).ok, false);
});

test("a fee with no recipient is refused rather than silently kept in escrow", () => {
  assert.match(
    validateFeePolicy(policy({ platformRecipient: "" })).errors.join(" "),
    /platform fee needs a recipient/,
  );
  assert.match(
    validateFeePolicy(policy({ agentOwnerFeeBps: 100, agentOwnerRecipient: null })).errors.join(" "),
    /needs an attributed recipient/,
  );
});

test("a zero fee needs no recipient", () => {
  assert.equal(
    validateFeePolicy({
      platformFeeBps: 0,
      agentOwnerFeeBps: 0,
      platformRecipient: "",
      agentOwnerRecipient: null,
    }).ok,
    true,
  );
});

// ── Snapshotting ──────────────────────────────────────────────────────────────

test("the snapshot freezes the terms a participant could see", () => {
  const live = policy({ platformFeeBps: 300 });
  const frozen = snapshotFeePolicy(live, { agentId: "acme", at: 500 });
  // The live policy changes afterwards…
  live.platformFeeBps = 1_000;
  // …and the market settles on what it was created under.
  const split = splitFees({
    principalUnits: U(10),
    grossPayoutUnits: U(110),
    snapshot: frozen,
    outcome: "creator_wins",
  });
  assert.equal(split.platformFeeUnits, U(3));
  assert.equal(frozen.agentId, "acme");
  assert.equal(frozen.takenAt, 500);
});

test("snapshot addresses are trimmed but never case-folded", () => {
  // A Stellar StrKey is case-sensitive, so lower-casing a recipient on the way into
  // the snapshot would store an address that cannot be paid. Only padding is
  // stripped.
  const frozen = snapshotFeePolicy(
    policy({ platformRecipient: ` ${PLATFORM} `, agentOwnerRecipient: `${AGENT_OWNER}
`, agentOwnerFeeBps: 100 }),
  );
  assert.equal(frozen.platformRecipient, PLATFORM);
  assert.equal(frozen.agentOwnerRecipient, AGENT_OWNER);

  const cased = snapshotFeePolicy(policy({ platformRecipient: PLATFORM.toUpperCase() }));
  assert.equal(cased.platformRecipient, PLATFORM.toUpperCase(), "case is preserved verbatim");
});

// ── Whole-market conservation ─────────────────────────────────────────────────

/** The roadmap's golden pool market, with real payout math. */
function goldenPool(): Participant[] {
  const creatorStake = U(10);
  const challengerStake = U(10);
  const challengerPool = U(100);
  const challengers: Participant[] = Array.from({ length: 10 }, (_, i) => ({
    address: `0x${String(i + 1).padStart(40, "0")}`,
    stakeUnits: challengerStake,
    grossPayoutUnits: poolChallengerPayoutUnits({
      stakeUnits: challengerStake,
      creatorStakeUnits: creatorStake,
      challengerPoolUnits: challengerPool,
    }).totalReturnUnits,
  }));
  return [{ address: CREATOR, stakeUnits: creatorStake, grossPayoutUnits: 0n }, ...challengers];
}

test("every atomic unit is accounted for when challengers win a pool", () => {
  const settlement = settleMarket({
    participants: goldenPool(),
    snapshot: snapshot(),
    outcome: "challengers_win",
  });
  assert.equal(conservationHolds(settlement), true);
  assert.equal(noWinnerLosesPrincipal(goldenPool(), settlement), true);
  assert.equal(settlement.escrowInflowUnits, U(110));
  // Ten winners of 1 USDC profit each, 3% of which is fee.
  assert.equal(settlement.totalPlatformFeeUnits, U(0.3));
  // The losing creator receives nothing: their stake is what paid the winners.
  assert.equal(settlement.payouts.some((p) => p.address === CREATOR), false);
  assert.equal(settlement.totalPayoutUnits, U(109.7));
  assert.equal(settlement.dustUnits, 0n);
});

test("every atomic unit is accounted for when the creator wins a pool", () => {
  const participants: Participant[] = [
    {
      address: CREATOR,
      stakeUnits: U(10),
      grossPayoutUnits: poolCreatorPayoutUnits({
        creatorStakeUnits: U(10),
        challengerPoolUnits: U(100),
      }).totalReturnUnits,
    },
    ...Array.from({ length: 10 }, (_, i) => ({
      address: `0x${String(i + 1).padStart(40, "0")}`,
      stakeUnits: U(10),
      grossPayoutUnits: 0n,
    })),
  ];
  const settlement = settleMarket({ participants, snapshot: snapshot(), outcome: "creator_wins" });
  assert.equal(conservationHolds(settlement), true);
  assert.equal(settlement.escrowInflowUnits, U(110));
  // Creator profit is 100; 3% of it is fee.
  assert.equal(settlement.totalPlatformFeeUnits, U(3));
  assert.equal(settlement.payouts[0]!.amountUnits, U(107));
});

test("a refunded market pays back exactly what came in, with zero fees and zero dust", () => {
  for (const outcome of ["draw", "unresolvable", "cancelled"] as SettlementOutcome[]) {
    const participants = goldenPool();
    const settlement = settleMarket({ participants, snapshot: snapshot(), outcome });
    assert.equal(conservationHolds(settlement), true, `${outcome} must conserve`);
    assert.equal(settlement.totalPayoutUnits, settlement.escrowInflowUnits);
    assert.equal(settlement.totalPlatformFeeUnits, 0n);
    assert.equal(settlement.dustUnits, 0n);
  }
});

test("a duel conserves and the winner keeps their principal", () => {
  const rival = "0x000000000000000000000000000000000000000b";
  const participants: Participant[] = [
    { address: CREATOR, stakeUnits: U(25), grossPayoutUnits: U(50) },
    { address: rival, stakeUnits: U(25), grossPayoutUnits: 0n },
  ];
  const settlement = settleMarket({ participants, snapshot: snapshot(), outcome: "creator_wins" });
  assert.equal(conservationHolds(settlement), true);
  assert.equal(noWinnerLosesPrincipal(participants, settlement), true);
  // 25 of profit, 3% fee.
  assert.equal(settlement.totalPlatformFeeUnits, U(0.75));
  assert.equal(settlement.payouts[0]!.amountUnits, U(49.25));
});

test("a fixed-odds market conserves when the creator keeps the remainder", () => {
  // Creator stakes 100 backing 2x; one challenger stakes 10 and wins 20.
  const challenger = "0x000000000000000000000000000000000000000c";
  const participants: Participant[] = [
    // The creator's unspent liability comes back as their gross payout.
    { address: CREATOR, stakeUnits: U(100), grossPayoutUnits: U(90) },
    { address: challenger, stakeUnits: U(10), grossPayoutUnits: U(20) },
  ];
  const settlement = settleMarket({
    participants,
    snapshot: snapshot(),
    outcome: "challengers_win",
  });
  assert.equal(conservationHolds(settlement), true);
  // The creator lost, so their 90 is a partial return, not profit — no fee on it.
  assert.equal(settlement.totalPlatformFeeUnits, U(0.3));
  assert.ok(settlement.dustUnits >= 0n);
});

// ── Dust ──────────────────────────────────────────────────────────────────────

test("fees round DOWN, in the participant's favour", () => {
  // 3% of 1 atomic unit is 0.03 units → truncates to 0.
  const split = splitFees({
    principalUnits: 10n,
    grossPayoutUnits: 11n,
    snapshot: snapshot(),
    outcome: "challengers_win",
  });
  assert.equal(split.grossProfitUnits, 1n);
  assert.equal(split.platformFeeUnits, 0n);
  assert.equal(split.payoutUnits, 11n);
});

test("truncated dust stays in escrow and is reported, never silently dropped", () => {
  // Three challengers of 1 unit each against a 5-unit creator stake: pool shares
  // truncate, so a residue is unavoidable.
  const participants: Participant[] = [
    { address: CREATOR, stakeUnits: 5n, grossPayoutUnits: 0n },
    ...Array.from({ length: 3 }, (_, i) => ({
      address: `0x${String(i + 1).padStart(40, "0")}`,
      stakeUnits: 1n,
      grossPayoutUnits: poolChallengerPayoutUnits({
        stakeUnits: 1n,
        creatorStakeUnits: 5n,
        challengerPoolUnits: 3n,
      }).totalReturnUnits,
    })),
  ];
  const settlement = settleMarket({
    participants,
    snapshot: snapshot(),
    outcome: "challengers_win",
  });
  assert.equal(conservationHolds(settlement), true);
  assert.ok(settlement.dustUnits > 0n, "this shape must produce a reported residue");
  assert.equal(noWinnerLosesPrincipal(participants, settlement), true);
});

test("dust is never negative — the escrow can never owe more than it holds", () => {
  for (const bps of [0, 1, 250, 1_000]) {
    const settlement = settleMarket({
      participants: goldenPool(),
      snapshot: snapshot({ platformFeeBps: bps }),
      outcome: "challengers_win",
    });
    assert.ok(settlement.dustUnits >= 0n, `bps ${bps} produced negative dust`);
    assert.equal(conservationHolds(settlement), true);
  }
});

// ── Attribution and double-counting ───────────────────────────────────────────

test("both fee lines accrue when a market is agent-attributed", () => {
  const settlement = settleMarket({
    participants: goldenPool(),
    snapshot: snapshot({
      platformFeeBps: 200,
      agentOwnerFeeBps: 100,
      agentOwnerRecipient: AGENT_OWNER,
      agentId: "acme",
    }),
    outcome: "challengers_win",
  });
  assert.equal(settlement.accruals.length, 2);
  assert.equal(conservationHolds(settlement), true);
});

test("no owner fee accrues without an attributed recipient", () => {
  const settlement = settleMarket({
    participants: goldenPool(),
    snapshot: snapshot({ agentOwnerFeeBps: 100, agentOwnerRecipient: null }),
    outcome: "challengers_win",
  });
  assert.deepEqual(
    settlement.accruals.map((line) => line.kind),
    ["platform_fee"],
  );
});

test("one address receiving both fees is merged, not double-counted", () => {
  // Platform and agent owner are commonly the same address in testing, and two
  // lines for one address would double-count in any downstream sum.
  const merged = mergeAccruals([
    { recipient: PLATFORM, amountUnits: U(2), kind: "platform_fee" },
    { recipient: ` ${PLATFORM}`, amountUnits: U(1), kind: "agent_owner_fee" },
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0]!.amountUnits, U(3));
  assert.equal(merged[0]!.recipient, PLATFORM);

  // ...but two addresses differing in CASE are two addresses on Stellar, and
  // merging them would pay one of them money the other earned.
  const notMerged = mergeAccruals([
    { recipient: PLATFORM, amountUnits: U(2), kind: "platform_fee" },
    { recipient: PLATFORM.toUpperCase(), amountUnits: U(1), kind: "agent_owner_fee" },
  ]);
  assert.equal(notMerged.length, 2);
});

test("distinct recipients stay distinct and are ordered deterministically", () => {
  const merged = mergeAccruals([
    { recipient: AGENT_OWNER, amountUnits: U(1), kind: "agent_owner_fee" },
    { recipient: PLATFORM, amountUnits: U(2), kind: "platform_fee" },
  ]);
  assert.deepEqual(
    merged.map((line) => line.recipient),
    [PLATFORM.toLowerCase(), AGENT_OWNER.toLowerCase()],
  );
});

// ── Zero-fee operation ────────────────────────────────────────────────────────

test("with fees at zero the market behaves exactly as it does today", () => {
  const participants = goldenPool();
  const settlement = settleMarket({
    participants,
    snapshot: snapshot({ platformFeeBps: 0, agentOwnerFeeBps: 0 }),
    outcome: "challengers_win",
  });
  assert.equal(settlement.totalPlatformFeeUnits, 0n);
  assert.equal(settlement.totalAgentOwnerFeeUnits, 0n);
  assert.deepEqual(settlement.accruals, []);
  assert.equal(conservationHolds(settlement), true);
  // Payouts match the unfeed gross payouts exactly.
  const grossTotal = participants.reduce((sum, p) => sum + p.grossPayoutUnits, 0n);
  assert.equal(settlement.totalPayoutUnits, grossTotal);
});

test("an empty market conserves trivially", () => {
  const settlement = settleMarket({
    participants: [],
    snapshot: snapshot(),
    outcome: "cancelled",
  });
  assert.equal(conservationHolds(settlement), true);
  assert.equal(settlement.escrowInflowUnits, 0n);
  assert.equal(settlement.dustUnits, 0n);
});

test("seeded fuzz conserves every atomic unit across 2,000 markets", () => {
  let seed = 0x6d696d69;
  const random = (): number => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return seed >>> 0;
  };
  for (let i = 0; i < 2_000; i += 1) {
    const creatorStake = BigInt((random() % 10_000_000) + 1);
    const challengerStake = BigInt((random() % 10_000_000) + 1);
    const inflow = creatorStake + challengerStake;
    const creatorWins = (random() & 1) === 0;
    const totalFeeBps = random() % 1_001;
    const ownerFeeBps = random() % (totalFeeBps + 1);
    const outcome: SettlementOutcome = random() % 5 === 0
      ? (["draw", "unresolvable", "cancelled"] as const)[random() % 3]!
      : creatorWins ? "creator_wins" : "challengers_win";
    const participants: Participant[] = [
      { address: CREATOR, stakeUnits: creatorStake, grossPayoutUnits: creatorWins ? inflow : 0n },
      { address: AGENT_OWNER, stakeUnits: challengerStake, grossPayoutUnits: creatorWins ? 0n : inflow },
    ];
    const result = settleMarket({
      participants,
      outcome,
      snapshot: snapshot({
        platformFeeBps: totalFeeBps - ownerFeeBps,
        agentOwnerFeeBps: ownerFeeBps,
        agentOwnerRecipient: (random() & 3) === 0 ? PLATFORM : AGENT_OWNER,
      }),
    });
    assert.equal(conservationHolds(result), true, `iteration ${i}`);
    assert.ok(result.dustUnits >= 0n, `iteration ${i} has negative dust`);
    if (isRefundOutcome(outcome)) {
      assert.equal(
        result.totalPlatformFeeUnits + result.totalAgentOwnerFeeUnits,
        0n,
        `iteration ${i} charged a refund`,
      );
      assert.equal(result.totalPayoutUnits, inflow, `iteration ${i} under-refunded`);
    } else {
      assert.equal(noWinnerLosesPrincipal(participants, result), true, `iteration ${i}`);
    }
  }
});

// ── Parity with the contract's fee rounding (contracts-soroban fees.rs) ────────

test("a fee leg with no recipient is not charged, matching the contract", () => {
  // An unattributed market snapshots the policy's owner bps with no recipient.
  // `quote_fees` charges nothing for that leg; the mirror must not either, or it
  // quotes a winner less than the contract actually pays.
  const args = {
    principalUnits: U(10),
    grossPayoutUnits: U(20),
    outcome: "challengers_win" as const,
  };
  const unattributed = splitFees({
    ...args,
    snapshot: snapshot({ agentOwnerFeeBps: 100, agentOwnerRecipient: null }),
  });
  const noOwnerFee = splitFees({ ...args, snapshot: snapshot({ agentOwnerFeeBps: 0 }) });
  assert.equal(unattributed.agentOwnerFeeUnits, 0n);
  assert.equal(unattributed.payoutUnits, noOwnerFee.payoutUnits);

  const settlement = settleMarket({
    participants: goldenPool(),
    snapshot: snapshot({ agentOwnerFeeBps: 100, agentOwnerRecipient: null }),
    outcome: "challengers_win",
  });
  assert.equal(settlement.totalAgentOwnerFeeUnits, 0n);
  assert.equal(conservationHolds(settlement), true);
});

test("fee legs round down exactly as the contract does", () => {
  const both = snapshot({
    platformFeeBps: 700,
    agentOwnerFeeBps: 300,
    agentOwnerRecipient: AGENT_OWNER,
  });
  const split = (profit: bigint) =>
    splitFees({
      principalUnits: U(2),
      grossPayoutUnits: U(2) + profit,
      snapshot: both,
      outcome: "challengers_win",
    });

  // The shared vector from test_fee_rounding.rs: 2,013 stroops of profit at
  // 7% + 3% is 140 + 60 = 200, where the exact fee is 201.3 and one 10% leg
  // would take 201. The winner keeps the remainder.
  const vector = split(2_013n);
  assert.equal(vector.platformFeeUnits, 140n);
  assert.equal(vector.agentOwnerFeeUnits, 60n);
  assert.equal(vector.payoutUnits, U(2) + 2_013n - 200n);

  // Every profit where truncation is proportionally largest.
  for (let profit = 0n; profit <= 25_000n; profit += 1n) {
    const { platformFeeUnits, agentOwnerFeeUnits, payoutUnits } = split(profit);
    assert.equal(platformFeeUnits, (profit * 700n) / 10_000n);
    assert.equal(agentOwnerFeeUnits, (profit * 300n) / 10_000n);
    const fee = platformFeeUnits + agentOwnerFeeUnits;
    assert.ok(fee * 10_000n <= profit * 1_000n, `profit ${profit}: fee above exact`);
    assert.equal(payoutUnits, U(2) + profit - fee);
  }
});
