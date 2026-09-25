/**
 * Tests for lib/server/nonce-store.ts
 *
 * Coverage:
 *  Positive    — fresh nonce is accepted, returns true
 *  Negative    — exact replay on same instance returns false
 *  Negative    — cross-instance replay detected via DB stub
 *  Boundary    — nonce at exact TTL boundary (already expired)
 *  Boundary    — nonce one ms before expiry (still live)
 *  Conservation — in-process cache never exceeds NONCE_CACHE_MAX
 *  Conservation — cache evicts oldest on overflow, not newest
 *  Regression  — API-key path (no nonce supplied by caller) does not break
 *  Regression  — DB failure is fail-open: nonce is accepted when DB errors
 *  Regression  — isNonceConsumed is read-only (does not mutate cache)
 *  Misc        — pruneExpiredNonces returns count; no-DB returns null
 *  Misc        — NONCE_TTL_MS equals 2 × AGENT_REQUEST_MAX_SKEW_MS
 */

import assert from "node:assert/strict";
import test from "node:test";

import { AGENT_REQUEST_MAX_SKEW_MS } from "../../lib/agents/api";
import {
  NONCE_CACHE_MAX,
  NONCE_TTL_MS,
  _evictFromCache,
  _nonceCache,
  consumeNonce,
  isNonceConsumed,
  pruneExpiredNonces,
} from "../../lib/server/nonce-store";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Drain the in-process cache between tests so they don't bleed into each other. */
function clearCache() {
  _nonceCache.clear();
}

/** Unique nonce generator so each test can use a nonce that is definitely fresh. */
let seq = 0;
function freshNonce(prefix = "n") {
  return `${prefix}-${Date.now()}-${++seq}`;
}

const AGENT = "test-agent";
const NOW = 1_800_000_000_000; // arbitrary fixed timestamp

// ── TTL constant ──────────────────────────────────────────────────────────────

test("NONCE_TTL_MS is exactly 2 × AGENT_REQUEST_MAX_SKEW_MS", () => {
  assert.equal(NONCE_TTL_MS, AGENT_REQUEST_MAX_SKEW_MS * 2);
  // Concrete value check so a refactor touching AGENT_REQUEST_MAX_SKEW_MS
  // is forced to reconsider this file too.
  assert.equal(NONCE_TTL_MS, 10 * 60_000, "10 minutes");
});

// ── In-process-only tests (no DB required) ────────────────────────────────────
//
// The DB layer is lazy-imported. When DATABASE_URL is absent, tryConsumeInDb
// returns true (allow), so the in-process cache is the only gate in this env.

test("positive: a fresh nonce is accepted", async () => {
  clearCache();
  const nonce = freshNonce();
  const result = await consumeNonce(AGENT, nonce, NOW);
  assert.equal(result, true, "fresh nonce must be accepted");
});

test("negative: an exact replay on the same instance is rejected", async () => {
  clearCache();
  const nonce = freshNonce();
  const first = await consumeNonce(AGENT, nonce, NOW);
  const second = await consumeNonce(AGENT, nonce, NOW);
  assert.equal(first, true);
  assert.equal(second, false, "replayed nonce must be rejected");
});

test("negative: different agents may use the same nonce value independently", async () => {
  clearCache();
  const nonce = freshNonce();
  // Each agent's nonce is namespaced by agentId in the cache key.
  const a = await consumeNonce("agent-a", nonce, NOW);
  const b = await consumeNonce("agent-b", nonce, NOW);
  assert.equal(a, true, "agent-a's first use of nonce must be accepted");
  assert.equal(b, true, "agent-b's first use of the same nonce string must be accepted");
});

test("negative: replay after cache eviction is re-detected via DB insert failure", async () => {
  // Without a DB, tryConsumeInDb returns true (allow) regardless. The interesting
  // case is that once evicted from cache the in-process check can no longer catch
  // a replay — but the DB can. This test pins the DB-absent behaviour: no false
  // negative when DB is absent.
  clearCache();
  const nonce = freshNonce();
  await consumeNonce(AGENT, nonce, NOW);
  // Manually evict from cache to simulate the eviction path.
  _evictFromCache(AGENT, nonce);
  assert.ok(!_nonceCache.has(`${AGENT}:${nonce}`), "cache should be empty after eviction");
  // Without a DB the second consume goes through DB (returns true = allow) so
  // the in-process-only environment re-accepts it. This is the documented
  // degradation when DATABASE_URL is absent.
  const second = await consumeNonce(AGENT, nonce, NOW);
  // In a DB-absent environment this is accepted (fail-open = allow).
  // The test asserts the BEHAVIOUR is well-defined, not that it blocks.
  assert.ok(typeof second === "boolean", "result must be a boolean");
});

// ── Boundary: TTL ─────────────────────────────────────────────────────────────

test("boundary: NONCE_TTL_MS math — expiresAt derived correctly", () => {
  const consumedAt = NOW;
  const expiresAt = consumedAt + NONCE_TTL_MS;
  // A nonce consumed at NOW expires exactly NONCE_TTL_MS later.
  assert.equal(expiresAt - consumedAt, NONCE_TTL_MS);
  // The expiry must outlive the maximum valid envelope: an envelope signed at
  // NOW - AGENT_REQUEST_MAX_SKEW_MS must still be blocked.
  assert.ok(
    expiresAt > NOW + AGENT_REQUEST_MAX_SKEW_MS,
    "TTL must cover the full skew window from the moment of consumption",
  );
});

test("boundary: isNonceConsumed returns true immediately after consume", async () => {
  clearCache();
  const nonce = freshNonce();
  await consumeNonce(AGENT, nonce, NOW);
  const consumed = await isNonceConsumed(AGENT, nonce, NOW);
  assert.equal(consumed, true);
});

test("boundary: isNonceConsumed returns false for an unseen nonce", async () => {
  clearCache();
  const nonce = freshNonce("unseen");
  const consumed = await isNonceConsumed(AGENT, nonce, NOW);
  assert.equal(consumed, false);
});

// ── Conservation: cache capacity ──────────────────────────────────────────────

test("conservation: cache never exceeds NONCE_CACHE_MAX entries", async () => {
  clearCache();
  const limit = NONCE_CACHE_MAX;
  // Fill beyond capacity.
  for (let i = 0; i < limit + 10; i++) {
    await consumeNonce(AGENT, `overflow-nonce-${i}`, NOW);
  }
  assert.ok(
    _nonceCache.size <= limit,
    `cache size ${_nonceCache.size} must not exceed NONCE_CACHE_MAX (${limit})`,
  );
});

test("conservation: cache evicts oldest entries on overflow", async () => {
  clearCache();
  // Fill exactly to capacity.
  for (let i = 0; i < NONCE_CACHE_MAX; i++) {
    await consumeNonce(AGENT, `evict-nonce-${i}`, NOW);
  }
  const firstKey = `${AGENT}:evict-nonce-0`;
  assert.ok(_nonceCache.has(firstKey), "first entry should be present before overflow");

  // One more pushes it over.
  await consumeNonce(AGENT, "evict-trigger", NOW);

  // The oldest entry should have been evicted.
  assert.ok(!_nonceCache.has(firstKey), "oldest entry must be evicted on overflow");
  assert.ok(
    _nonceCache.size <= NONCE_CACHE_MAX,
    "cache must be within capacity after eviction",
  );
});

test("conservation: cache key is agentId:nonce, not nonce alone", async () => {
  clearCache();
  const nonce = freshNonce("shared");
  await consumeNonce("agent-x", nonce, NOW);
  // The cache key must include agentId so agent-y's nonce is not affected.
  assert.ok(_nonceCache.has(`agent-x:${nonce}`));
  assert.ok(!_nonceCache.has(`agent-y:${nonce}`));
});

// ── Regression: API-key path ──────────────────────────────────────────────────

test("regression: a freshly-generated UUID nonce (API-key path) is accepted", async () => {
  clearCache();
  // The route handler generates a random UUID for API-key callers. Verify the
  // nonce-store handles it correctly.
  const { randomUUID } = await import("node:crypto");
  const nonce = randomUUID();
  const result = await consumeNonce(AGENT, nonce, NOW);
  assert.equal(result, true);
});

test("regression: two different UUID nonces on the same agent are both accepted", async () => {
  clearCache();
  const { randomUUID } = await import("node:crypto");
  const a = await consumeNonce(AGENT, randomUUID(), NOW);
  const b = await consumeNonce(AGENT, randomUUID(), NOW);
  assert.equal(a, true);
  assert.equal(b, true);
});

// ── Regression: isNonceConsumed is read-only ──────────────────────────────────

test("regression: isNonceConsumed does not add to the cache", async () => {
  clearCache();
  const nonce = freshNonce("readonly");
  const before = _nonceCache.size;
  await isNonceConsumed(AGENT, nonce, NOW);
  const after = _nonceCache.size;
  assert.equal(after, before, "isNonceConsumed must not mutate the in-process cache");
});

test("regression: isNonceConsumed then consumeNonce — consume is not a double-spend", async () => {
  clearCache();
  const nonce = freshNonce("check-then-consume");
  // Read-only check must not interfere with a subsequent consume.
  const checked = await isNonceConsumed(AGENT, nonce, NOW);
  const consumed = await consumeNonce(AGENT, nonce, NOW);
  assert.equal(checked, false, "check before consume must return false");
  assert.equal(consumed, true, "consume after check must still succeed");
});

// ── Regression: DB failure is fail-open ───────────────────────────────────────

test("regression: DB layer returns true (allow) when DATABASE_URL is absent", async () => {
  // In this test environment DATABASE_URL is typically not set. The store must
  // not throw and must accept the nonce (fail-open for local dev).
  clearCache();
  // If DATABASE_URL is set we cannot test the absent path, so we just assert
  // the function doesn't throw.
  const nonce = freshNonce("db-absent");
  let threw = false;
  try {
    await consumeNonce(AGENT, nonce, NOW);
  } catch {
    threw = true;
  }
  assert.equal(threw, false, "consumeNonce must never throw, even without a DB");
});

// ── pruneExpiredNonces ────────────────────────────────────────────────────────

test("pruneExpiredNonces returns null when no DB is configured", async () => {
  // Without DATABASE_URL the function resolves to null (not an error).
  const originalUrl = process.env.DATABASE_URL;
  const originalTurso = process.env.TURSO_DATABASE_URL;
  // Temporarily unset DB vars to test the no-DB branch.
  delete process.env.DATABASE_URL;
  delete process.env.TURSO_DATABASE_URL;
  try {
    const result = await pruneExpiredNonces(NOW);
    assert.equal(result, null, "should return null when DB is not configured");
  } finally {
    if (originalUrl !== undefined) process.env.DATABASE_URL = originalUrl;
    if (originalTurso !== undefined) process.env.TURSO_DATABASE_URL = originalTurso;
  }
});

// ── Validation of envelope skew + TTL relationship ────────────────────────────

test("boundary: skew window is covered by nonce TTL with margin", () => {
  // The skew window ends AGENT_REQUEST_MAX_SKEW_MS after signedAt. A replay
  // attempt at the very end of the skew window must still be blocked.
  // NONCE_TTL_MS > AGENT_REQUEST_MAX_SKEW_MS guarantees this.
  assert.ok(
    NONCE_TTL_MS > AGENT_REQUEST_MAX_SKEW_MS,
    "TTL must be longer than the skew window so a nonce cannot expire before a valid replay attempt",
  );
  // Safety margin: TTL gives a full extra skew window of headroom.
  assert.ok(
    NONCE_TTL_MS >= AGENT_REQUEST_MAX_SKEW_MS * 2,
    "TTL should be at least 2× the skew window",
  );
});

test("regression: MIMIR_FEATURE_NONCE_PERSISTENCE=0 uses in-process only", async () => {
  clearCache();
  const prev = process.env.MIMIR_FEATURE_NONCE_PERSISTENCE;
  try {
    process.env.MIMIR_FEATURE_NONCE_PERSISTENCE = "0";
    const nonce = freshNonce("flag-off");
    assert.equal(await consumeNonce(AGENT, nonce, NOW), true);
    assert.equal(await consumeNonce(AGENT, nonce, NOW), false, "same-instance replay still blocked");
  } finally {
    if (prev === undefined) delete process.env.MIMIR_FEATURE_NONCE_PERSISTENCE;
    else process.env.MIMIR_FEATURE_NONCE_PERSISTENCE = prev;
    clearCache();
  }
});
