/**
 * Reject replayed signed agent envelopes.
 *
 * A signed agent envelope is a single-use credential: the same `(agentId, nonce)`
 * must authorise at most one mutation within the freshness window. Timestamp skew
 * alone is not enough — inside ±AGENT_REQUEST_MAX_SKEW_MS a captured envelope
 * could be presented repeatedly. The durable nonce store (see
 * `lib/server/nonce-store.ts`) closes that window.
 *
 * Call this AFTER envelope validation and signature verification, and BEFORE any
 * money-moving or authority-changing side effect. Returning a structured
 * `ApiErrorResult` keeps autonomous clients on the machine-readable path
 * (`code: "nonce_reused"`, `retryable: false`) instead of free-form 409 prose.
 */

import { AGENT_REQUEST_MAX_SKEW_MS } from "@/lib/agents/api";
import { apiError, type ApiErrorResult } from "@/lib/api/errors";
import { consumeNonce } from "@/lib/server/nonce-store";

export type EnvelopeReplayArgs = {
  agentId: string;
  nonce: string;
  /** Client-side epoch ms carried by the signed envelope. */
  signedAt: number;
  now?: number;
};

/**
 * Consume the envelope nonce, or return the error a route should send.
 *
 * `null` means the envelope is fresh and the nonce is now spent — proceed.
 */
export async function rejectReplayedSignedEnvelope(
  args: EnvelopeReplayArgs,
): Promise<ApiErrorResult | null> {
  const now = args.now ?? Date.now();
  const agentId = args.agentId?.trim() ?? "";
  const nonce = args.nonce?.trim() ?? "";

  if (!agentId) {
    return apiError("invalid_request", "agentId is required", { field: "agentId" });
  }
  if (!nonce || nonce.length > 128) {
    return apiError("invalid_request", "invalid nonce", { field: "nonce" });
  }
  // Defense in depth: validateAgentRequestEnvelope already checks skew, but a
  // stale capture must never reach the durable store as a "fresh" consume.
  if (!Number.isFinite(args.signedAt) || Math.abs(now - args.signedAt) > AGENT_REQUEST_MAX_SKEW_MS) {
    return apiError("request_expired", "signed timestamp outside allowed window", {
      field: "signedAt",
    });
  }

  const consumed = await consumeNonce(agentId, nonce, now);
  if (!consumed) {
    return apiError(
      "nonce_reused",
      "signed agent envelope was already used; generate a fresh nonce",
      { field: "nonce" },
    );
  }
  return null;
}
