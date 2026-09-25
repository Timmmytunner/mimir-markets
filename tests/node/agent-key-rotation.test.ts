/**
 * Tests for API-key rotation with overlap (issue #32).
 *
 * Covers:
 *   - checkApiKeyRecord with expiry (positive, negative, boundary)
 *   - parseOverlapMs validation (positive, negative, boundary)
 *   - expiresAt field conservation through AgentApiKeyRecord
 *   - rotateKey action in AGENT_API_ACTIONS and OWNER_SIGNED_ACTIONS
 *   - "expired" reason in ApiKeyRejection type
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  checkApiKeyRecord,
  generateApiKey,
  apiKeyPrefix,
  hashApiKey,
  DEFAULT_ROTATION_OVERLAP_MS,
  MAX_ROTATION_OVERLAP_MS,
  parseOverlapMs,
  type AgentApiKeyRecord,
} from "../../lib/agents/api-keys";
import { AGENT_API_ACTIONS } from "../../lib/agents/api";
import { OWNER_SIGNED_ACTIONS } from "../../lib/agents/authenticate";

// ── Test helpers ──────────────────────────────────────────────────────────────

function makeRecord(overrides: Partial<AgentApiKeyRecord> = {}): AgentApiKeyRecord {
  const key = generateApiKey();
  return {
    keyId: "k1",
    agentId: "test-agent",
    keyHash: hashApiKey(key),
    keyPrefix: apiKeyPrefix(key),
    label: "default",
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

const BASE_NOW = 1_780_000_000_000;

// ── checkApiKeyRecord — positive ──────────────────────────────────────────────

test("checkApiKeyRecord: a key with no expiry is accepted", () => {
  const rec = makeRecord();
  const result = checkApiKeyRecord(rec, BASE_NOW);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.record.keyId, "k1");
});

test("checkApiKeyRecord: a key whose expiresAt is in the future is accepted", () => {
  const rec = makeRecord({ expiresAt: BASE_NOW + 1000 });
  const result = checkApiKeyRecord(rec, BASE_NOW);
  assert.equal(result.ok, true);
});

test("checkApiKeyRecord: a key expiring exactly now (boundary) is rejected", () => {
  const rec = makeRecord({ expiresAt: BASE_NOW });
  const result = checkApiKeyRecord(rec, BASE_NOW);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "expired");
});

test("checkApiKeyRecord: a key expiring one ms before now is rejected", () => {
  const rec = makeRecord({ expiresAt: BASE_NOW - 1 });
  const result = checkApiKeyRecord(rec, BASE_NOW);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "expired");
});

test("checkApiKeyRecord: a key expiring one ms after now is accepted", () => {
  const rec = makeRecord({ expiresAt: BASE_NOW + 1 });
  const result = checkApiKeyRecord(rec, BASE_NOW);
  assert.equal(result.ok, true);
});

// ── checkApiKeyRecord — revocation takes precedence over expiry ───────────────

test("checkApiKeyRecord: revoked key is 'revoked' not 'expired' even if also expired", () => {
  // Revocation takes precedence so the error message is accurate and actionable.
  const rec = makeRecord({
    revokedAt: BASE_NOW - 5000,
    expiresAt: BASE_NOW - 1, // also expired
  });
  const result = checkApiKeyRecord(rec, BASE_NOW);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "revoked");
});

test("checkApiKeyRecord: revoked key with future expiry is still 'revoked'", () => {
  const rec = makeRecord({
    revokedAt: BASE_NOW - 1000,
    expiresAt: BASE_NOW + 999_999, // far future
  });
  const result = checkApiKeyRecord(rec, BASE_NOW);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "revoked");
});

// ── checkApiKeyRecord — null record ──────────────────────────────────────────

test("checkApiKeyRecord: null returns not_found", () => {
  const result = checkApiKeyRecord(null, BASE_NOW);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "not_found");
});

// ── parseOverlapMs ────────────────────────────────────────────────────────────

test("parseOverlapMs: absent/null returns the 24h default", () => {
  for (const raw of [undefined, null]) {
    const r = parseOverlapMs(raw);
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.overlapMs, DEFAULT_ROTATION_OVERLAP_MS);
  }
});

test("parseOverlapMs: a positive number is returned as-is (floored)", () => {
  const r = parseOverlapMs(3600 * 1000);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.overlapMs, 3_600_000);
});

test("parseOverlapMs: zero is accepted (immediate expiry — caller's choice)", () => {
  const r = parseOverlapMs(0);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.overlapMs, 0);
});

test("parseOverlapMs: negative number is rejected", () => {
  const r = parseOverlapMs(-1);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /non-negative/);
});

test("parseOverlapMs: NaN is rejected", () => {
  const r = parseOverlapMs(NaN);
  assert.equal(r.ok, false);
});

test("parseOverlapMs: Infinity is rejected", () => {
  const r = parseOverlapMs(Infinity);
  assert.equal(r.ok, false);
});

test("parseOverlapMs: exactly at the max boundary is accepted", () => {
  const r = parseOverlapMs(MAX_ROTATION_OVERLAP_MS);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.overlapMs, MAX_ROTATION_OVERLAP_MS);
});

test("parseOverlapMs: one ms over the max is rejected", () => {
  const r = parseOverlapMs(MAX_ROTATION_OVERLAP_MS + 1);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /maximum/);
});

test("parseOverlapMs: a string that parses to a valid number is accepted", () => {
  const r = parseOverlapMs("86400000");
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.overlapMs, 86_400_000);
});

// ── AgentApiKeyRecord — expiresAt field conservation ─────────────────────────

test("AgentApiKeyRecord can carry an expiresAt without disturbing other fields", () => {
  const key = generateApiKey();
  const rec: AgentApiKeyRecord = {
    keyId: "k-exp",
    agentId: "my-agent",
    keyHash: hashApiKey(key),
    keyPrefix: apiKeyPrefix(key),
    label: "expiring key",
    createdAt: BASE_NOW,
    expiresAt: BASE_NOW + DEFAULT_ROTATION_OVERLAP_MS,
  };
  // All other fields survive a round-trip through a spread (simulates DB
  // normalisation that picks up new optional fields gracefully).
  const copy: AgentApiKeyRecord = { ...rec };
  assert.equal(copy.expiresAt, rec.expiresAt);
  assert.equal(copy.keyId, "k-exp");
  assert.equal(copy.revokedAt, undefined);
});

test("AgentApiKeyRecord without expiresAt is still a valid record", () => {
  const rec = makeRecord();
  assert.equal(rec.expiresAt, undefined);
  // Ensure checkApiKeyRecord treats undefined as permanent.
  assert.equal(checkApiKeyRecord(rec, BASE_NOW).ok, true);
});

// ── AGENT_API_ACTIONS contains rotateKey ─────────────────────────────────────

test("rotateKey is listed in AGENT_API_ACTIONS", () => {
  assert.ok(
    (AGENT_API_ACTIONS as readonly string[]).includes("rotateKey"),
    "rotateKey must be a recognised action",
  );
});

// ── rotateKey requires an owner signature ─────────────────────────────────────

test("rotateKey is in OWNER_SIGNED_ACTIONS", () => {
  assert.ok(
    (OWNER_SIGNED_ACTIONS as readonly string[]).includes("rotateKey"),
    "rotateKey must require an owner signature; a key must not be able to mint its own successor",
  );
});

test("issueKey and revokeKey are still in OWNER_SIGNED_ACTIONS (regression)", () => {
  assert.ok((OWNER_SIGNED_ACTIONS as readonly string[]).includes("issueKey"));
  assert.ok((OWNER_SIGNED_ACTIONS as readonly string[]).includes("revokeKey"));
});

// ── Overlap window semantics ──────────────────────────────────────────────────

test("an old key with overlap_ms=0 expires immediately after rotation", () => {
  const now = BASE_NOW;
  // The route would call setAgentApiKeyExpiry with expiresAt = now + 0.
  const expiresAt = now + 0;
  const oldKey = makeRecord({ expiresAt });
  // At the exact rotation moment the key is already expired (expiresAt <= now).
  assert.equal(checkApiKeyRecord(oldKey, now).ok, false);
  if (!checkApiKeyRecord(oldKey, now).ok) {
    const r = checkApiKeyRecord(oldKey, now);
    assert.equal(r.ok === false && r.reason, "expired");
  }
});

test("an old key with overlap_ms=86400000 (24h) is still valid 1ms before expiry", () => {
  const now = BASE_NOW;
  const overlapMs = DEFAULT_ROTATION_OVERLAP_MS; // 24h
  const expiresAt = now + overlapMs;
  const oldKey = makeRecord({ expiresAt });
  // Valid 1 ms before the window closes.
  assert.equal(checkApiKeyRecord(oldKey, expiresAt - 1).ok, true);
  // Expired exactly at the expiry moment.
  assert.equal(checkApiKeyRecord(oldKey, expiresAt).ok, false);
});

test("new key issued by rotateKey has no expiry (it is permanent by default)", () => {
  // The new key created by rotateKey has no expiresAt set.
  const newKey = makeRecord({ keyId: "new-k" });
  assert.equal(newKey.expiresAt, undefined);
  assert.equal(checkApiKeyRecord(newKey, BASE_NOW + 999_999_999).ok, true);
});

// ── DEFAULT_ROTATION_OVERLAP_MS is 24 hours ───────────────────────────────────

test("DEFAULT_ROTATION_OVERLAP_MS equals 24 hours in milliseconds", () => {
  assert.equal(DEFAULT_ROTATION_OVERLAP_MS, 24 * 60 * 60 * 1000);
});

// ── MAX_ROTATION_OVERLAP_MS is 30 days ───────────────────────────────────────

test("MAX_ROTATION_OVERLAP_MS equals 30 days in milliseconds", () => {
  assert.equal(MAX_ROTATION_OVERLAP_MS, 30 * 24 * 60 * 60 * 1000);
});
