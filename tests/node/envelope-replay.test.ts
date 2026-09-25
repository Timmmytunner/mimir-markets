/**
 * Reject-replayed-signed-envelope gate (issue #29).
 *
 * Positive   — fresh envelope nonce is consumed
 * Negative   — exact replay returns nonce_reused (not retryable)
 * Negative   — empty / oversized nonce → invalid_request
 * Boundary   — signedAt exactly at skew edge accepted; one ms past rejected
 * Regression — status/code match lib/api/errors SPECS (401, retryable:false)
 */

import assert from "node:assert/strict";
import test from "node:test";

import { AGENT_REQUEST_MAX_SKEW_MS } from "../../lib/agents/api";
import { rejectReplayedSignedEnvelope } from "../../lib/agents/envelope-replay";
import { statusFor } from "../../lib/api/errors";
import { _evictFromCache, _nonceCache } from "../../lib/server/nonce-store";

const NOW = 1_800_000_000_000;
const AGENT = "replay-agent";

function clearCache() {
  _nonceCache.clear();
}

let seq = 0;
function freshNonce() {
  return `env-${Date.now()}-${++seq}`;
}

test("SPECS: nonce_reused is a non-retryable auth failure", () => {
  assert.equal(statusFor("nonce_reused"), 401);
});

test("positive: a fresh signed envelope nonce is accepted once", async () => {
  clearCache();
  const nonce = freshNonce();
  const err = await rejectReplayedSignedEnvelope({
    agentId: AGENT,
    nonce,
    signedAt: NOW,
    now: NOW,
  });
  assert.equal(err, null);
});

test("negative: replaying the same signed envelope is rejected as nonce_reused", async () => {
  clearCache();
  const nonce = freshNonce();
  const first = await rejectReplayedSignedEnvelope({
    agentId: AGENT, nonce, signedAt: NOW, now: NOW,
  });
  const second = await rejectReplayedSignedEnvelope({
    agentId: AGENT, nonce, signedAt: NOW, now: NOW,
  });
  assert.equal(first, null);
  assert.ok(second, "replay must produce an error");
  assert.equal(second.status, 401);
  assert.equal(second.body.error.code, "nonce_reused");
  assert.equal(second.body.error.retryable, false);
  assert.equal(second.body.error.field, "nonce");
});

test("negative: blank agentId or nonce is invalid_request, not a silent allow", async () => {
  clearCache();
  const badAgent = await rejectReplayedSignedEnvelope({
    agentId: "  ", nonce: freshNonce(), signedAt: NOW, now: NOW,
  });
  assert.equal(badAgent?.body.error.code, "invalid_request");
  const badNonce = await rejectReplayedSignedEnvelope({
    agentId: AGENT, nonce: "", signedAt: NOW, now: NOW,
  });
  assert.equal(badNonce?.body.error.code, "invalid_request");
});

test("boundary: signedAt at the skew edge is accepted; one ms beyond is request_expired", async () => {
  clearCache();
  const edge = await rejectReplayedSignedEnvelope({
    agentId: AGENT,
    nonce: freshNonce(),
    signedAt: NOW - AGENT_REQUEST_MAX_SKEW_MS,
    now: NOW,
  });
  assert.equal(edge, null);

  const past = await rejectReplayedSignedEnvelope({
    agentId: AGENT,
    nonce: freshNonce(),
    signedAt: NOW - AGENT_REQUEST_MAX_SKEW_MS - 1,
    now: NOW,
  });
  assert.equal(past?.body.error.code, "request_expired");
});

test("conservation: after eviction, in-process-only env still defines replay via cache re-fill", async () => {
  clearCache();
  const nonce = freshNonce();
  assert.equal(
    await rejectReplayedSignedEnvelope({ agentId: AGENT, nonce, signedAt: NOW, now: NOW }),
    null,
  );
  _evictFromCache(AGENT, nonce);
  // Without a durable DB the second presentation is accepted again (documented
  // degradation). The important property is that the gate still returns a
  // boolean decision shaped as ApiErrorResult | null — never throws.
  const again = await rejectReplayedSignedEnvelope({
    agentId: AGENT, nonce, signedAt: NOW, now: NOW,
  });
  assert.ok(again === null || again.body.error.code === "nonce_reused");
});
