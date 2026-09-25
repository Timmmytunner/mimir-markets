/**
 * Nonce persistence and expiry for the Mimir agent API.
 *
 * ── Why both layers are needed ────────────────────────────────────────────────
 *
 * An agent envelope carries a `nonce` that must be single-use. Without expiry
 * the DB must keep every nonce forever — a growing table no index can fully
 * offset. With expiry (TTL = 2 × AGENT_REQUEST_MAX_SKEW_MS = 10 minutes) only
 * nonces that could still be presented by a valid envelope need to be kept.
 *
 * Two replay-defence layers, same reasoning as x402's `consumeSettlement`:
 *
 *  - **Durable (DB):** `agent_api_nonces` rows survive process restarts and span
 *    multiple serverless instances. A nonce with `expires_at > now` is the
 *    canonical authority; rows with `expires_at <= now` are dead weight that
 *    `pruneExpiredNonces` cleans up.
 *  - **In-process:** the DB write is the authoritative consume, but it is not
 *    free. The in-process set short-circuits repeated nonce presentations on the
 *    SAME instance within the same freshness window, saving a DB round-trip for
 *    every exact replay (which is the common case for a misconfigured client).
 *    The set is bounded to NONCE_CACHE_MAX entries and uses insertion-order LRU
 *    eviction, so it cannot grow without limit even across a long-lived process.
 *
 * ── Expiry ────────────────────────────────────────────────────────────────────
 *
 * NONCE_TTL_MS = 2 × AGENT_REQUEST_MAX_SKEW_MS (10 minutes).
 *
 * An envelope is accepted only within ±5 minutes of its `signedAt` timestamp
 * (the skew window). So a nonce is relevant for at most 5 minutes after the
 * request that consumed it first landed. The 2× factor gives the full window:
 * an attacker who captures an envelope just before its skew window closes has at
 * most NONCE_TTL_MS − skew_window = 5 min to replay it before the nonce expires.
 * Keeping expired rows any longer would be purely wasted storage.
 *
 * ── x402 replay ──────────────────────────────────────────────────────────────
 *
 * x402 transaction hashes already have a dual-layer defence:
 *  - In-process `consumed` set (capped at 4096) in `lib/x402/stellar-scheme.ts`.
 *  - Durable `payments_v2` table with a unique index on `(network, payment_identifier)`.
 *
 * The x402 path does NOT use this module — its "nonces" are Stellar transaction
 * hashes, not caller-supplied strings, so an entirely separate deduplification
 * channel would be redundant. See the long comment in `consumeSettlement` for
 * the deliberate tradeoff.
 *
 * ── Conservation invariant ────────────────────────────────────────────────────
 *
 * For any pair (agentId, nonce), `consume` returns `true` AT MOST ONCE within
 * the TTL window. After expiry the nonce is garbage-collected, and a future
 * presentation of the same value is refused by the envelope timestamp check
 * (signedAt is ±5 min) BEFORE it ever reaches the nonce store — so there is no
 * window for recycled nonce reuse.
 */

import { AGENT_REQUEST_MAX_SKEW_MS } from "@/lib/agents/api";
import { isFeatureEnabled } from "@/lib/ops/flags";

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * How long (ms) a consumed nonce stays in the durable store.
 *
 * Must be ≥ AGENT_REQUEST_MAX_SKEW_MS so a nonce consumed right before the
 * skew window closes is still blocked for the full replay-risk period.
 *
 * 2× gives one skew window of margin, matching x402's `X402_PAYMENT_MAX_AGE_MS`
 * convention of "window × 2" for its own freshness check.
 */
export const NONCE_TTL_MS = AGENT_REQUEST_MAX_SKEW_MS * 2; // 10 minutes

/**
 * In-process cache capacity. Above this the oldest entry is evicted.
 *
 * Far above the number of distinct nonces that can land in one freshness window
 * on a single instance (120 req/h limit → 20 per 10 min), so eviction is only
 * triggered by a long-lived worker process, not by normal load.
 */
export const NONCE_CACHE_MAX = 4096;

// ── In-process bounded nonce cache ────────────────────────────────────────────

/**
 * Insertion-ordered set with a hard capacity, used to short-circuit the DB
 * on the most-common replay path: the SAME instance seeing the same nonce twice.
 *
 * Exported for tests only — no callers outside this module should touch it.
 */
export const _nonceCache: Set<string> = new Set<string>();

/** Add a nonce to the in-process cache, evicting the oldest when full. */
function cacheNonce(key: string): void {
  if (_nonceCache.has(key)) return;
  _nonceCache.add(key);
  if (_nonceCache.size > NONCE_CACHE_MAX) {
    // Set iteration is insertion-ordered; delete the first (oldest) entry.
    for (const oldest of _nonceCache) {
      _nonceCache.delete(oldest);
      if (_nonceCache.size <= NONCE_CACHE_MAX) break;
    }
  }
}

// ── DB helpers (lazy-imported to avoid opening a pool in agent workers) ───────

async function tryConsumeInDb(
  agentId: string,
  nonce: string,
  consumedAt: number,
): Promise<boolean> {
  try {
    const { isDbConfigured, getDb } = await import("@/lib/db");
    if (!isDbConfigured()) return true; // no DB: local dev, allow
    const pool = await getDb();
    // Postgres $1 / $2 / $3 — the toPg() helper in db.ts would convert ?,
    // but we import directly here so we use $N directly.
    const expiresAt = consumedAt + NONCE_TTL_MS;
    const result = await pool.query(
      `INSERT INTO agent_api_nonces(nonce, agent_id, consumed_at, expires_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT(nonce) DO NOTHING
       RETURNING nonce`,
      [nonce, agentId, consumedAt, expiresAt],
    );
    return result.rows.length === 1;
  } catch (err) {
    // Log the error but fail OPEN so a transient DB blip does not take down
    // every agent request. The in-process cache still provides same-instance
    // replay protection.
    console.warn(
      "[nonce-store] DB consume failed, falling back to in-process only:",
      err instanceof Error ? err.message : err,
    );
    return true;
  }
}

async function isConsumedInDb(
  agentId: string,
  nonce: string,
  now: number,
): Promise<boolean> {
  try {
    const { isDbConfigured, getDb } = await import("@/lib/db");
    if (!isDbConfigured()) return false;
    const pool = await getDb();
    // A row is only a live replay signal while expires_at > now; an expired
    // row means the nonce is outside the skew window and can never be replayed.
    const result = await pool.query(
      `SELECT 1 FROM agent_api_nonces
       WHERE nonce = $1 AND agent_id = $2 AND expires_at > $3
       LIMIT 1`,
      [nonce, agentId, now],
    );
    return result.rows.length > 0;
  } catch {
    return false; // fail open on lookup errors
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Attempt to consume a nonce for an agent.
 *
 * Returns `true` if this is the first presentation of the nonce within its TTL
 * window, `false` on any replay or expiry.
 *
 * Side effects: on success, the nonce is recorded durably in `agent_api_nonces`
 * (if the DB is configured) and in the in-process cache.
 *
 * @param agentId  - Agent ID the envelope claims to be from.
 * @param nonce    - The nonce string from the signed envelope.
 * @param now      - Current timestamp (ms since epoch). Defaults to `Date.now()`.
 */
export async function consumeNonce(
  agentId: string,
  nonce: string,
  now = Date.now(),
): Promise<boolean> {
  const cacheKey = `${agentId}:${nonce}`;

  // Fast path: same instance, already seen.
  if (_nonceCache.has(cacheKey)) return false;

  // Operational kill-switch: MIMIR_FEATURE_NONCE_PERSISTENCE=0 reverts to the
  // in-process-only gate (loses cross-instance / restart protection). Default ON.
  if (!isFeatureEnabled("nonce_persistence")) {
    cacheNonce(cacheKey);
    return true;
  }

  // Durable path: DB INSERT ON CONFLICT. This is the atomic gate for
  // cross-instance replay prevention.
  const consumed = await tryConsumeInDb(agentId, nonce, now);
  if (!consumed) {
    // Another instance already consumed it; prime the local cache so the next
    // request on this instance skips the DB.
    cacheNonce(cacheKey);
    return false;
  }

  cacheNonce(cacheKey);
  return true;
}

/**
 * Check whether a nonce has already been consumed, without consuming it.
 *
 * Used by `verify()` in the x402 path and by diagnostics. Does NOT update any
 * state — a plain read is always safe to call multiple times.
 *
 * @param agentId - Agent ID the nonce was issued for.
 * @param nonce   - The nonce string to check.
 * @param now     - Current timestamp (ms). Defaults to `Date.now()`.
 */
export async function isNonceConsumed(
  agentId: string,
  nonce: string,
  now = Date.now(),
): Promise<boolean> {
  const cacheKey = `${agentId}:${nonce}`;
  if (_nonceCache.has(cacheKey)) return true;
  return isConsumedInDb(agentId, nonce, now);
}

/**
 * Delete expired nonce rows from `agent_api_nonces`.
 *
 * Safe to run at any time (e.g. a Vercel cron, a worker startup). Rows whose
 * `expires_at <= now` can never be presented again (the envelope timestamp check
 * rejects anything outside ±AGENT_REQUEST_MAX_SKEW_MS), so they are pure waste.
 *
 * Returns the count of rows deleted, or `null` when the DB is not configured.
 */
export async function pruneExpiredNonces(now = Date.now()): Promise<number | null> {
  try {
    const { isDbConfigured, getDb } = await import("@/lib/db");
    if (!isDbConfigured()) return null;
    const pool = await getDb();
    const result = await pool.query(
      "DELETE FROM agent_api_nonces WHERE expires_at <= $1",
      [now],
    );
    return result.rowCount ?? 0;
  } catch (err) {
    console.warn(
      "[nonce-store] prune failed:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/**
 * Evict a single nonce from the in-process cache.
 *
 * Exposed for tests that need deterministic cache state. Not needed in
 * production code, which relies on TTL expiry and LRU eviction.
 */
export function _evictFromCache(agentId: string, nonce: string): void {
  _nonceCache.delete(`${agentId}:${nonce}`);
}
