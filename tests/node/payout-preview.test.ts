import assert from "node:assert/strict";
import test from "node:test";

import {
  feeStateFromClaimFees,
  feeStateFromTerms,
  isPlausibleFeeTerms,
  isPrincipalSafe,
  PENDING_FEE_STATE,
  previewChallengerPayout,
  previewChallengerPayoutSafe,
  principalSafePayout,
  toPrincipalSafePreview,
  type PayoutBreakdown,
} from "../../lib/payout";
import {
  FEE_SCHEDULE,
  MAX_TOTAL_FEE_BPS,
  snapshotFeePolicy,
  splitFees,
} from "../../lib/fees";
import {
  AGENT_OWNER_RECIPIENT,
  claimFeeView,
  feeTerms,
  GOLDEN,
  gross,
  grossUnits,
  invalidFees,
  loadingFees,
  PLATFORM_RECIPIENT,
  readyFees,
  U,
  unavailableFees,
  VIEWER,
} from "./payout-preview-fixtures";

// ── Positive: the preview is the contract's own fee arithmetic ────────────────

test("a winning challenger sees the fee taken off profit, not off the stake", () => {
  // 10 USDC into a challenger side that becomes 100, against a 10 USDC creator:
  // gross 11, profit 1. The published 0.5 / 0.5 schedule takes 0.005 each.
  const preview = previewChallengerPayoutSafe({
    settlementMode: "pool",
    stake: GOLDEN.stakeUsdc,
    creatorStake: GOLDEN.creatorStakeUsdc,
    challengerPoolBefore: GOLDEN.challengerPoolBeforeUsdc,
    fees: readyFees(),
  });

  assert.equal(preview.feeAdjusted, true);
  assert.equal(preview.gross.totalReturn, 11);
  assert.equal(preview.principal, 10);
  assert.equal(preview.platformFee, 0.005);
  assert.equal(preview.agentOwnerFee, 0.005);
  assert.equal(preview.totalFee, 0.01);
  assert.equal(preview.netPayout, 10.99);
  assert.equal(preview.netProfit, 0.99);
  assert.equal(preview.netMultiple, 1.099);
  assert.equal(preview.clamped, false);
});

test("the net matches fees.rs::quote_fees leg for leg", () => {
  // Parity with lib/fees.ts, which mirrors the Rust: two independently computed
  // floors, remainder kept by the participant. If this drifts, the preview is
  // promising a payout the contract will not make.
  for (const [stake, profit] of [
    [10, 1],
    [10, 20],
    [25, 25],
    [0.5, 0.13],
  ] as const) {
    const breakdown = gross(stake, profit);
    const viaPreview = principalSafePayout({ gross: breakdown, feeState: readyFees() });
    const viaFees = splitFees({
      principalUnits: breakdown.returnedPrincipalUnits,
      grossPayoutUnits: breakdown.totalReturnUnits,
      outcome: "challengers_win",
      snapshot: snapshotFeePolicy({
        platformFeeBps: FEE_SCHEDULE.platformBps,
        agentOwnerFeeBps: FEE_SCHEDULE.agentOwnerBps,
        platformRecipient: PLATFORM_RECIPIENT,
        agentOwnerRecipient: AGENT_OWNER_RECIPIENT,
      }),
    });
    assert.equal(viaPreview.split.payoutUnits, viaFees.payoutUnits, `stake ${stake}`);
    assert.equal(viaPreview.split.platformFeeUnits, viaFees.platformFeeUnits, `stake ${stake}`);
    assert.equal(viaPreview.split.agentOwnerFeeUnits, viaFees.agentOwnerFeeUnits);
  }

  // The 1-atomic-unit boundary, built in units because `1e-7` does not survive a
  // number round-trip.
  const unit = grossUnits(U(2), 1n);
  const viaPreview = principalSafePayout({ gross: unit, feeState: readyFees() });
  const viaFees = splitFees({
    principalUnits: unit.returnedPrincipalUnits,
    grossPayoutUnits: unit.totalReturnUnits,
    outcome: "challengers_win",
    snapshot: snapshotFeePolicy({
      platformFeeBps: FEE_SCHEDULE.platformBps,
      agentOwnerFeeBps: FEE_SCHEDULE.agentOwnerBps,
      platformRecipient: PLATFORM_RECIPIENT,
      agentOwnerRecipient: AGENT_OWNER_RECIPIENT,
    }),
  });
  assert.equal(viaPreview.split.payoutUnits, viaFees.payoutUnits);
  assert.equal(viaPreview.split.payoutUnits, unit.totalReturnUnits, "a 1-unit fee floors to zero");
});

test("fixed-odds and duel previews are fee-adjusted too", () => {
  const fixed = previewChallengerPayoutSafe({
    settlementMode: "fixed_odds",
    stake: 10,
    creatorStake: 100,
    challengerPoolBefore: 0,
    challengerPayoutBps: 30_000,
    fees: readyFees(),
  });
  // gross 30 on a 10 stake; 0.1 + 0.1 off the 20 of profit.
  assert.equal(fixed.gross.totalReturn, 30);
  assert.equal(fixed.netPayout, 29.8);
  assert.equal(fixed.netProfit, 19.8);

  const duel = previewChallengerPayoutSafe({
    settlementMode: "duel",
    stake: 25,
    creatorStake: 25,
    challengerPoolBefore: 0,
    fees: readyFees(),
  });
  assert.equal(duel.gross.totalReturn, 50);
  assert.equal(duel.netPayout, 49.75);
});

test("a leg with no recipient is not charged, exactly as the contract does", () => {
  const unattributed = previewChallengerPayoutSafe({
    settlementMode: "pool",
    stake: GOLDEN.stakeUsdc,
    creatorStake: GOLDEN.creatorStakeUsdc,
    challengerPoolBefore: GOLDEN.challengerPoolBeforeUsdc,
    fees: readyFees({ agentOwnerRecipient: null }),
  });
  assert.equal(unattributed.agentOwnerFee, 0);
  assert.equal(unattributed.platformFee, 0.005);
  assert.equal(unattributed.totalFee, 0.005);

  const noPlatform = previewChallengerPayoutSafe({
    settlementMode: "pool",
    stake: GOLDEN.stakeUsdc,
    creatorStake: GOLDEN.creatorStakeUsdc,
    challengerPoolBefore: GOLDEN.challengerPoolBeforeUsdc,
    fees: readyFees({ platformRecipient: null }),
  });
  assert.equal(noPlatform.platformFee, 0);
  assert.equal(noPlatform.totalFee, 0.005);
});

// ── The invariant: a winner keeps every unit of principal ─────────────────────

test("net payout never falls below the stake, across a grid of markets", () => {
  for (const mode of ["pool", "duel", "fixed_odds", "squad_pool"] as const) {
    for (const stake of [2, 5, 10, 33.33, 250]) {
      for (const fees of [readyFees(), readyFees({ platformRecipient: null })]) {
        const preview = previewChallengerPayoutSafe({
          settlementMode: mode,
          stake,
          creatorStake: 40,
          challengerPoolBefore: 12.5,
          challengerPayoutBps: 20_000,
          fees,
        });
        assert.ok(
          preview.netPayout >= preview.principal,
          `${mode} at ${stake}: net ${preview.netPayout} < principal ${preview.principal}`,
        );
        assert.ok(preview.netProfit >= 0);
      }
    }
  }
});

test("the deduction is conserved: net profit plus fees is the gross profit", () => {
  const preview = previewChallengerPayoutSafe({
    settlementMode: "fixed_odds",
    stake: 10,
    creatorStake: 100,
    challengerPoolBefore: 0,
    challengerPayoutBps: 25_000,
    fees: readyFees(),
  });
  assert.equal(preview.netProfit + preview.totalFee, preview.gross.netProfit);
  assert.equal(preview.netPayout + preview.totalFee, preview.gross.totalReturn);
});

test("both safety gates are explicit and tell the truth about a broken split", () => {
  const safe = principalSafePayout({ gross: gross(10, 5), feeState: readyFees() });
  assert.equal(isPrincipalSafe(safe), true);

  // A split that pays out less than the stake — the exact shape the clamp exists
  // to prevent. `isPrincipalSafe` must refuse it rather than round it away.
  const broken = {
    split: {
      principalUnits: U(10),
      grossProfitUnits: U(5),
      platformFeeUnits: 0n,
      agentOwnerFeeUnits: 0n,
      netProfitUnits: 0n,
      payoutUnits: U(9),
    },
  };
  assert.equal(isPrincipalSafe(broken), false);
});

// ── Boundary: one atomic unit, and zero-fee markets ───────────────────────────

test("one atomic unit of profit is kept whole — each leg floors to zero", () => {
  const preview = previewChallengerPayoutSafe({
    settlementMode: "pool",
    stake: 10,
    creatorStake: 10,
    // Join makes the pool 10, so the creator's whole stake would be the profit;
    // a 1-unit profit comes from a stake that truncates to it.
    challengerPoolBefore: 0,
    fees: readyFees(),
  });
  // Sanity: the zero-fee pool case is unchanged by the fee layer.
  assert.equal(preview.gross.netProfit, 10);

  // Now the boundary itself, on the fee step alone. (In atomic units: a JS number
  // cannot round-trip 1e-7.)
  const unit = toPrincipalSafePreview(
    principalSafePayout({ gross: grossUnits(U(10), 1n), feeState: readyFees() }),
  );
  assert.equal(unit.feeAdjusted, true);
  assert.equal(unit.totalFee, 0);
  assert.equal(unit.netProfit, 0.0000001);
  assert.equal(unit.netPayout, 10.0000001);
});

test("a zero stake previews zero and stays principal-safe", () => {
  const breakdown: PayoutBreakdown = {
    totalReturnUnits: 0n,
    returnedPrincipalUnits: 0n,
    netProfitUnits: 0n,
  };
  const preview = toPrincipalSafePreview(
    principalSafePayout({ gross: breakdown, feeState: readyFees() }),
  );
  assert.equal(preview.netPayout, 0);
  assert.equal(preview.netMultiple, 0);
  assert.equal(preview.totalFee, 0);
  assert.equal(isPrincipalSafe({ split: principalSafePayout({
    gross: breakdown,
    feeState: readyFees(),
  }).split }), true);
});

test("a payout that only returns the stake is charged nothing", () => {
  const preview = toPrincipalSafePreview(
    principalSafePayout({
      gross: { totalReturnUnits: U(10), returnedPrincipalUnits: U(10), netProfitUnits: 0n },
      feeState: readyFees(),
    }),
  );
  assert.equal(preview.totalFee, 0);
  assert.equal(preview.netPayout, 10);
  assert.equal(preview.netProfit, 0);
});

// ── Negative: an untrustworthy snapshot is refused, never clamped silently ────

test("a snapshot over the contract's fee cap is invalid, not applied", () => {
  for (const terms of [
    feeTerms({ platformFeeBps: 600, agentOwnerFeeBps: 600 }),
    feeTerms({ platformFeeBps: 90_000 }),
    feeTerms({ platformFeeBps: -1 }),
    feeTerms({ platformFeeBps: 2.5 }),
    feeTerms({ agentOwnerFeeBps: Number.NaN }),
  ]) {
    assert.equal(isPlausibleFeeTerms(terms), false);
    assert.equal(feeStateFromTerms(terms).status, "invalid");

    const preview = previewChallengerPayoutSafe({
      settlementMode: "pool",
      stake: 10,
      creatorStake: 10,
      challengerPoolBefore: 90,
      fees: feeStateFromTerms(terms),
    });
    assert.equal(preview.feeStatus, "invalid");
    assert.equal(preview.feeAdjusted, false);
    assert.equal(preview.totalFee, 0);
    assert.equal(preview.netPayout, preview.gross.totalReturn);
  }
});

test("the cap is inclusive: exactly 1000 bps is still a valid snapshot", () => {
  const atCap = feeTerms({
    platformFeeBps: Number(MAX_TOTAL_FEE_BPS),
    agentOwnerFeeBps: 0,
    agentOwnerRecipient: null,
  });
  assert.equal(isPlausibleFeeTerms(atCap), true);
  assert.equal(feeStateFromTerms(atCap).status, "ready");
});

test("the clamp is a backstop: an over-cap snapshot can never eat the stake", () => {
  // Bypasses `feeStateFromTerms` on purpose. This is the shape a corrupt read or a
  // future fee-math bug would take, and it must still lose to `payout >= principal`.
  const preview = toPrincipalSafePreview(
    principalSafePayout({
      gross: gross(10, 5),
      feeState: { status: "ready", terms: feeTerms({ platformFeeBps: 9_000, agentOwnerFeeBps: 9_000 }) },
    }),
  );
  assert.equal(preview.clamped, true);
  assert.equal(preview.totalFee, 5, "the fee is capped at the profit");
  assert.equal(preview.netPayout, preview.principal);
  assert.equal(preview.netProfit, 0);
  assert.ok(preview.netPayout >= preview.principal);
});

// ── Dependency failure: loading / unavailable preview the gross and say so ────

test("with no fee terms the preview is the gross, and must not claim otherwise", () => {
  for (const fees of [loadingFees, unavailableFees, invalidFees, PENDING_FEE_STATE]) {
    const preview = previewChallengerPayoutSafe({
      settlementMode: "pool",
      stake: GOLDEN.stakeUsdc,
      creatorStake: GOLDEN.creatorStakeUsdc,
      challengerPoolBefore: GOLDEN.challengerPoolBeforeUsdc,
      fees,
    });
    assert.equal(preview.feeStatus, fees.status);
    assert.equal(preview.feeAdjusted, false);
    assert.equal(preview.totalFee, 0);
    assert.equal(preview.netPayout, preview.gross.totalReturn);
    assert.equal(preview.netProfit, preview.gross.netProfit);
  }
});

test("a missing reader defaults to unavailable rather than assuming no fee", () => {
  const preview = previewChallengerPayoutSafe({
    settlementMode: "pool",
    stake: GOLDEN.stakeUsdc,
    creatorStake: GOLDEN.creatorStakeUsdc,
    challengerPoolBefore: GOLDEN.challengerPoolBeforeUsdc,
  });
  assert.equal(preview.feeStatus, "unavailable");
  assert.equal(preview.feeAdjusted, false);
});

test("the contract's snake_case view is adapted, and a null answer is unavailable", () => {
  assert.deepEqual(feeStateFromClaimFees(claimFeeView()), {
    status: "ready",
    terms: feeTerms(),
  });
  assert.equal(feeStateFromClaimFees(null).status, "unavailable");
  assert.equal(feeStateFromClaimFees(undefined).status, "unavailable");
  assert.equal(
    feeStateFromClaimFees(claimFeeView({ platform_fee_bps: 600, agent_owner_fee_bps: 600 })).status,
    "invalid",
  );
});

// ── Regression: gross behaviour is untouched and the warning follows the net ──

test("the existing gross preview is byte-for-byte what it was", () => {
  const args = {
    settlementMode: "pool" as const,
    stake: GOLDEN.stakeUsdc,
    creatorStake: GOLDEN.creatorStakeUsdc,
    challengerPoolBefore: GOLDEN.challengerPoolBeforeUsdc,
  };
  const legacy = previewChallengerPayout(args);
  const safe = previewChallengerPayoutSafe({ ...args, fees: unavailableFees });
  assert.deepEqual(safe.gross, legacy);
  assert.equal(safe.netPayout, legacy.totalReturn);

  // With fees ready, the gross is still reported unchanged next to the net.
  const withFees = previewChallengerPayoutSafe({ ...args, fees: readyFees() });
  assert.deepEqual(withFees.gross, legacy);
});

test("the low-upside warning is measured on the net, so a fee can cross the line", () => {
  // 2020 bps of gross upside is just above the thin-upside line; the 1.25% fee
  // takes it to 1999 bps. Warning on the gross would tell the user nothing.
  const grossBreakdown = gross(10, 2.02);
  assert.equal(toPrincipalSafePreview(
    principalSafePayout({ gross: grossBreakdown, feeState: unavailableFees }),
  ).isLowUpside, false);

  const withFees = toPrincipalSafePreview(
    principalSafePayout({ gross: grossBreakdown, feeState: readyFees() }),
  );
  assert.equal(withFees.netUpsideBps, 1_999);
  assert.equal(withFees.isLowUpside, true);
});

test("the split does not depend on who is looking — no leg is waived by earner", () => {
  // `fees.rs::quote_fees` charges an agent-owner leg whenever the claim has a
  // recipient; it does not waive it because the earner happens to be the owner.
  // (That waiver lives in `splitAttributedFees`, which is off-chain accounting and
  // not the contract's settlement.) A preview keyed on the viewer would promise a
  // fee the contract still takes.
  const asOwner = previewChallengerPayoutSafe({
    settlementMode: "pool",
    stake: GOLDEN.stakeUsdc,
    creatorStake: GOLDEN.creatorStakeUsdc,
    challengerPoolBefore: GOLDEN.challengerPoolBeforeUsdc,
    fees: readyFees({ agentOwnerRecipient: VIEWER }),
  });
  const asStranger = previewChallengerPayoutSafe({
    settlementMode: "pool",
    stake: GOLDEN.stakeUsdc,
    creatorStake: GOLDEN.creatorStakeUsdc,
    challengerPoolBefore: GOLDEN.challengerPoolBeforeUsdc,
    fees: readyFees(),
  });
  assert.equal(asOwner.netPayout, asStranger.netPayout);
  assert.equal(asOwner.agentOwnerFee, 0.005);
});
