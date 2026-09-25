import assert from "node:assert/strict";
import test from "node:test";

import {
  checkCreatorExposureCap,
  exposureSkipReason,
  exposureUsdcForClaim,
  marketsRemainingUnderCap,
  parseExposureCapPolicy,
  sumCreatorOpenExposure,
  type CreatorExposureClaim,
} from "../../lib/market-creator/exposure-caps";
import {
  decideMode,
  defaultCreatorPolicy,
  type CandidateInput,
} from "../../lib/market-creator/mode-matrix";

const NOW = 1_800_000_000;
const CREATOR = "GCREATORADDRESSEXAMPLE0000000000000000000000000000000";
const OTHER = "GOTHERADDRESSEXAMPLE000000000000000000000000000000000";

function claim(overrides: Partial<CreatorExposureClaim> = {}): CreatorExposureClaim {
  return {
    id: 1,
    creator: CREATOR,
    state: "open",
    deadline: NOW + 3600,
    creatorStakeUsdc: 10,
    reservedCreatorLiabilityUsdc: 0,
    ...overrides,
  };
}

// ── Config validation ─────────────────────────────────────────────────────────

test("parseExposureCapPolicy defaults to 100 USDC", () => {
  const parsed = parseExposureCapPolicy({});
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.equal(parsed.policy.maxOpenExposureUsdc, 100);
});

test("parseExposureCapPolicy reads MARKET_CREATOR_MAX_EXPOSURE_USDC", () => {
  const parsed = parseExposureCapPolicy({ MARKET_CREATOR_MAX_EXPOSURE_USDC: "250" });
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.equal(parsed.policy.maxOpenExposureUsdc, 250);
});

test("parseExposureCapPolicy rejects NaN and negative ceilings", () => {
  assert.equal(parseExposureCapPolicy({ maxOpenExposureUsdc: Number.NaN }).ok, false);
  assert.equal(parseExposureCapPolicy({ maxOpenExposureUsdc: -1 }).ok, false);
  assert.equal(parseExposureCapPolicy({ MARKET_CREATOR_MAX_EXPOSURE_USDC: "nope" }).ok, false);
});

test("a zero ceiling is valid and blocks every positive stake", () => {
  const parsed = parseExposureCapPolicy({ maxOpenExposureUsdc: 0 });
  assert.equal(parsed.ok, true);
  const decision = checkCreatorExposureCap({
    openExposureUsdc: 0,
    stakeUsdc: 2,
    maxOpenExposureUsdc: 0,
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "cap_exceeded");
});

// ── What counts toward exposure ───────────────────────────────────────────────

test("live open/active claims from the creator count", () => {
  assert.equal(exposureSkipReason(claim(), CREATOR, NOW), null);
  assert.equal(exposureSkipReason(claim({ state: "active" }), CREATOR, NOW), null);
  assert.equal(exposureUsdcForClaim(claim({ creatorStakeUsdc: 5, reservedCreatorLiabilityUsdc: 3 })), 8);
});

test("other creators, resolved, cancelled, and expired claims are skipped", () => {
  assert.equal(exposureSkipReason(claim({ creator: OTHER }), CREATOR, NOW), "other_creator");
  assert.equal(exposureSkipReason(claim({ state: "resolved" }), CREATOR, NOW), "not_open");
  assert.equal(exposureSkipReason(claim({ state: "cancelled" }), CREATOR, NOW), "not_open");
  assert.equal(exposureSkipReason(claim({ deadline: NOW }), CREATOR, NOW), "expired");
  assert.equal(exposureSkipReason(claim({ deadline: NOW - 1 }), CREATOR, NOW), "expired");
});

test("malformed stakes are skipped rather than counted", () => {
  assert.equal(exposureSkipReason(claim({ creatorStakeUsdc: Number.NaN }), CREATOR, NOW), "malformed_stake");
  assert.equal(exposureSkipReason(claim({ creatorStakeUsdc: -2 }), CREATOR, NOW), "malformed_stake");
  assert.equal(
    exposureSkipReason(claim({ reservedCreatorLiabilityUsdc: Number.NaN }), CREATOR, NOW),
    "malformed_stake",
  );
});

test("duplicate claim ids are counted once", () => {
  const claims = [claim({ id: 7, creatorStakeUsdc: 10 }), claim({ id: 7, creatorStakeUsdc: 10 })];
  const sum = sumCreatorOpenExposure({ claims, creatorAddress: CREATOR, nowSeconds: NOW });
  assert.equal(sum.openExposureUsdc, 10);
  assert.deepEqual(sum.countedClaimIds, [7]);
  assert.equal(sum.skipped.some((s) => s.reason === "duplicate"), true);
});

test("sumCreatorOpenExposure ignores foreign and dead rows", () => {
  const sum = sumCreatorOpenExposure({
    creatorAddress: CREATOR,
    nowSeconds: NOW,
    claims: [
      claim({ id: 1, creatorStakeUsdc: 10 }),
      claim({ id: 2, creator: OTHER, creatorStakeUsdc: 99 }),
      claim({ id: 3, state: "cancelled", creatorStakeUsdc: 99 }),
      claim({ id: 4, deadline: NOW - 5, creatorStakeUsdc: 99 }),
      claim({ id: 5, state: "active", creatorStakeUsdc: 4, reservedCreatorLiabilityUsdc: 1 }),
    ],
  });
  assert.equal(sum.openExposureUsdc, 15);
  assert.deepEqual(sum.countedClaimIds, [1, 5]);
});

// ── Cap enforcement ───────────────────────────────────────────────────────────

test("positive: stake that fits under the cap is allowed", () => {
  const decision = checkCreatorExposureCap({
    openExposureUsdc: 40,
    stakeUsdc: 10,
    maxOpenExposureUsdc: 100,
  });
  assert.equal(decision.allowed, true);
  assert.equal(decision.nextExposureUsdc, 50);
  assert.equal(decision.headroomUsdc, 60);
});

test("negative: stake that would exceed the cap is refused", () => {
  const decision = checkCreatorExposureCap({
    openExposureUsdc: 96,
    stakeUsdc: 5,
    maxOpenExposureUsdc: 100,
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "cap_exceeded");
  assert.match(decision.blockedBy ?? "", /101 > 100/);
});

test("boundary: exposure exactly at the cap is allowed", () => {
  const decision = checkCreatorExposureCap({
    openExposureUsdc: 95,
    stakeUsdc: 5,
    maxOpenExposureUsdc: 100,
  });
  assert.equal(decision.allowed, true);
  assert.equal(decision.nextExposureUsdc, 100);
});

test("failure: zero / non-finite stake is refused", () => {
  assert.equal(
    checkCreatorExposureCap({ openExposureUsdc: 0, stakeUsdc: 0, maxOpenExposureUsdc: 100 }).reason,
    "invalid_stake",
  );
  assert.equal(
    checkCreatorExposureCap({ openExposureUsdc: 0, stakeUsdc: Number.NaN, maxOpenExposureUsdc: 100 }).reason,
    "invalid_stake",
  );
});

test("marketsRemainingUnderCap floors remaining slots", () => {
  assert.equal(
    marketsRemainingUnderCap({ openExposureUsdc: 94, stakeUsdc: 2, maxOpenExposureUsdc: 100 }),
    3,
  );
  assert.equal(
    marketsRemainingUnderCap({ openExposureUsdc: 99, stakeUsdc: 2, maxOpenExposureUsdc: 100 }),
    0,
  );
});

// ── Regression: stays aligned with decideMode ─────────────────────────────────

test("regression: checkCreatorExposureCap matches decideMode exposure skip", () => {
  const policy = defaultCreatorPolicy({
    MARKET_CREATOR_AUTONOMOUS: "1",
    MARKET_CREATOR_MAX_EXPOSURE_USDC: "100",
  });
  const candidate: CandidateInput = {
    subjectType: "binary",
    category: "crypto",
    availableLiquidityUsdc: 50,
    stakeUsdc: 5,
    openExposureUsdc: 96,
    activeMarkets: 2,
    qualityScore: 80,
  };
  const mode = decideMode(candidate, "pool", policy);
  const cap = checkCreatorExposureCap({
    openExposureUsdc: candidate.openExposureUsdc,
    stakeUsdc: candidate.stakeUsdc,
    maxOpenExposureUsdc: policy.maxOpenExposureUsdc,
  });
  assert.equal(mode.disposition, "skip");
  assert.equal(cap.allowed, false);
  assert.equal(mode.blockedBy, cap.blockedBy);
});
