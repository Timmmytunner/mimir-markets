/**
 * API keys for the agent API.
 *
 * A key is a bearer credential, so the blast radius has to be bounded by something
 * other than the credential itself: what a key can spend is capped by the
 * owner-signed spend permission, and the owner can revoke either side
 * independently. A leaked key costs at most the remaining allowance.
 *
 * Only the SHA-256 of the secret is stored. The secret is returned once, at issue,
 * and cannot be recovered afterwards — a database dump therefore does not hand over
 * working credentials.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** Distinguishes a real key from a sandbox one at a glance in logs and support. */
export type ApiKeyEnvironment = "live" | "test";

export const API_KEY_PREFIX_LENGTH = 14;

function environmentTag(env: ApiKeyEnvironment): string {
  return env === "live" ? "mk_live_" : "mk_test_";
}

/**
 * 32 bytes of randomness, base64url so the whole key is copy-pasteable into a
 * shell and an Authorization header without escaping.
 */
export function generateApiKey(env: ApiKeyEnvironment = "live"): string {
  return `${environmentTag(env)}${randomBytes(32).toString("base64url")}`;
}

export function isApiKeyFormat(value: string): boolean {
  return /^mk_(live|test)_[A-Za-z0-9_-]{20,}$/.test(value.trim());
}

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key.trim(), "utf8").digest("hex");
}

/** Shown in listings so an owner can tell two keys apart without seeing either. */
export function apiKeyPrefix(key: string): string {
  return key.trim().slice(0, API_KEY_PREFIX_LENGTH);
}

/**
 * Compare two hashes without leaking where they differ. Both are hex digests of
 * fixed width, so a length mismatch means malformed input rather than a near miss.
 */
export function hashesMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/**
 * Pull the key out of an Authorization header.
 *
 * Accepts a bare key too: agents are written by third parties against curl
 * examples, and rejecting `Authorization: mk_live_…` teaches nothing useful.
 */
export function parseApiKeyHeader(header: string | null | undefined): string | null {
  if (!header) return null;
  const raw = header.trim();
  const value = /^bearer\s+/i.test(raw) ? raw.replace(/^bearer\s+/i, "").trim() : raw;
  return isApiKeyFormat(value) ? value : null;
}

export interface AgentApiKeyRecord {
  keyId: string;
  agentId: string;
  keyHash: string;
  keyPrefix: string;
  label: string;
  createdAt: number;
  lastUsedAt?: number;
  /**
   * Unix milliseconds after which this key is no longer valid.
   *
   * Absent means the key never expires automatically (permanent). Set explicitly
   * during key rotation so the old key continues to work through the overlap
   * window, then silently stops authenticating once the window closes.
   */
  expiresAt?: number;
  revokedAt?: number;
  revokedReason?: string;
}

export type ApiKeyRejection = "not_found" | "revoked" | "expired";

/**
 * Pure decision so the accept/reject rule is testable without a database.
 *
 * Order matters: revocation is always checked before expiry so that an owner who
 * revokes during the overlap window gets an immediate stop ("revoked") rather than
 * waiting for the window to close ("expired").
 */
export function checkApiKeyRecord(
  record: AgentApiKeyRecord | null,
  now = Date.now(),
): { ok: true; record: AgentApiKeyRecord } | { ok: false; reason: ApiKeyRejection } {
  if (!record) return { ok: false, reason: "not_found" };
  if (record.revokedAt) return { ok: false, reason: "revoked" };
  if (record.expiresAt !== undefined && record.expiresAt <= now) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true, record };
}

/**
 * Default overlap duration for key rotation: 24 hours in milliseconds.
 *
 * The outgoing key remains valid for this window so any service that has already
 * loaded it can continue to run while the operator distributes the new one. After
 * the window closes the old key silently stops authenticating.
 */
export const DEFAULT_ROTATION_OVERLAP_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Maximum allowed overlap duration: 30 days. Prevents accidentally immortal keys. */
export const MAX_ROTATION_OVERLAP_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Parse and validate an overlap duration from an owner-supplied value (milliseconds).
 * Falls back to the default if absent. Returns an error string if the value is
 * out of range.
 */
export function parseOverlapMs(
  raw: unknown,
): { ok: true; overlapMs: number } | { ok: false; error: string } {
  if (raw === undefined || raw === null) {
    return { ok: true, overlapMs: DEFAULT_ROTATION_OVERLAP_MS };
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    return { ok: false, error: "overlap_ms must be a non-negative number" };
  }
  if (n > MAX_ROTATION_OVERLAP_MS) {
    return {
      ok: false,
      error: `overlap_ms exceeds the maximum of ${MAX_ROTATION_OVERLAP_MS} ms (30 days)`,
    };
  }
  return { ok: true, overlapMs: Math.floor(n) };
}
