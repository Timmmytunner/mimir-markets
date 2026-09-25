import assert from "node:assert/strict";
import test from "node:test";

import { MIN_STAKE } from "../../lib/constants";
import {
  claimCreationDraftFixture,
  validateClaimCreationBeforeSign,
} from "../../lib/claimCreationValidation";

const NOW_MS = 1_800_000_000_000;

test("positive: well-formed draft with connected signer is ok", () => {
  const result = validateClaimCreationBeforeSign(
    claimCreationDraftFixture({ nowMs: NOW_MS })
  );
  assert.equal(result.status, "ok");
  assert.equal(result.ok, true);
  assert.ok(result.parsed);
  assert.equal(result.parsed?.stake, MIN_STAKE);
  assert.ok((result.parsed?.deadlineTimestamp ?? 0) > Math.floor(NOW_MS / 1000));
  assert.equal(
    result.parsed?.resolutionUrl,
    "https://coingecko.com/en/coins/bitcoin"
  );
});

test("positive: demo create skips wallet connectivity checks", () => {
  const result = validateClaimCreationBeforeSign(
    claimCreationDraftFixture({
      nowMs: NOW_MS,
      isDemo: true,
      isConnected: false,
      address: null,
      hasSigner: false,
    })
  );
  assert.equal(result.status, "ok");
  assert.equal(result.ok, true);
});

test("negative: empty claim fields are invalid", () => {
  const result = validateClaimCreationBeforeSign(
    claimCreationDraftFixture({
      nowMs: NOW_MS,
      question: "   ",
      creatorPosition: "",
      opponentPosition: "No",
    })
  );
  assert.equal(result.status, "invalid");
  assert.equal(result.messageKey, "fillAllFields");
  assert.equal(result.ok, false);
});

test("negative: disconnected wallet blocks signing", () => {
  const result = validateClaimCreationBeforeSign(
    claimCreationDraftFixture({
      nowMs: NOW_MS,
      isConnected: false,
      address: null,
    })
  );
  assert.equal(result.status, "disconnected");
  assert.equal(result.messageKey, "connectWalletFirst");
});

test("negative: connected wallet without signer cannot sign", () => {
  const result = validateClaimCreationBeforeSign(
    claimCreationDraftFixture({
      nowMs: NOW_MS,
      hasSigner: false,
    })
  );
  assert.equal(result.status, "cannot_sign");
  assert.equal(result.messageKey, "walletCannotSign");
});

test("boundary: stake exactly at MIN_STAKE is accepted", () => {
  const result = validateClaimCreationBeforeSign(
    claimCreationDraftFixture({ nowMs: NOW_MS, stake: MIN_STAKE })
  );
  assert.equal(result.status, "ok");
});

test("boundary: stake just below MIN_STAKE is invalid", () => {
  const result = validateClaimCreationBeforeSign(
    claimCreationDraftFixture({ nowMs: NOW_MS, stake: MIN_STAKE - 0.01 })
  );
  assert.equal(result.status, "invalid");
  assert.equal(result.messageKey, "invalidStakeMin");
  assert.deepEqual(result.messageParams, { amount: MIN_STAKE });
});

test("boundary: past deadline is stale", () => {
  const customDeadline = new Date(NOW_MS - 60 * 60 * 1000)
    .toISOString()
    .slice(0, 16);
  const result = validateClaimCreationBeforeSign(
    claimCreationDraftFixture({ nowMs: NOW_MS, customDeadline })
  );
  assert.equal(result.status, "stale");
  assert.equal(result.messageKey, "invalidDeadline");
});

test("negative: missing resolution source is invalid", () => {
  const result = validateClaimCreationBeforeSign(
    claimCreationDraftFixture({ nowMs: NOW_MS, resolutionUrl: "not a url" })
  );
  assert.equal(result.status, "invalid");
  assert.equal(result.messageKey, "sourceRequired");
});

test("negative: custom category requires a specific settlement rule", () => {
  const result = validateClaimCreationBeforeSign(
    claimCreationDraftFixture({
      nowMs: NOW_MS,
      requiresExplicitSettlementRule: true,
      settlementRule: "too short",
    })
  );
  assert.equal(result.status, "invalid");
  assert.equal(result.messageKey, "settlementRuleRequired");
});

test("dependency_failure: impossible fixed-odds payout is rejected", () => {
  const result = validateClaimCreationBeforeSign(
    claimCreationDraftFixture({
      nowMs: NOW_MS,
      settlementMode: "fixed_odds",
      challengerPayoutBps: 10_000, // exactly 1x — not allowed
    })
  );
  assert.equal(result.status, "dependency_failure");
  assert.equal(result.ok, false);
  assert.ok(result.detail);
});

test("loading: moderation in flight blocks signing", () => {
  const result = validateClaimCreationBeforeSign(
    claimCreationDraftFixture({
      nowMs: NOW_MS,
      moderation: {
        enabled: true,
        loading: true,
        currentKey: "abc",
      },
    })
  );
  assert.equal(result.status, "loading");
  assert.equal(result.ok, false);
});

test("stale: moderation approval fingerprint no longer matches draft", () => {
  const result = validateClaimCreationBeforeSign(
    claimCreationDraftFixture({
      nowMs: NOW_MS,
      moderation: {
        enabled: true,
        loading: false,
        currentKey: "draft-v2",
        approvedKey: "draft-v1",
        decision: "allow",
      },
    })
  );
  assert.equal(result.status, "stale");
  assert.equal(result.messageKey, "moderationNeedsReview");
});

test("regression: funded pool flow with future deadline stays compatible", () => {
  const result = validateClaimCreationBeforeSign(
    claimCreationDraftFixture({
      nowMs: NOW_MS,
      settlementMode: "pool",
      stake: 25,
      marketType: "binary",
      poolSlots: 4,
    })
  );
  assert.equal(result.status, "ok");
  assert.equal(result.parsed?.maxChallengers, 4);
  assert.equal(result.parsed?.challengerPayoutBps, 0);
  assert.equal(result.parsed?.marketType, "binary");
});
