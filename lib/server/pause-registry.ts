/**
 * Central pause-reason registry — the single place an API layer calls to get a
 * canonical, structured explanation for why a capability is paused.
 *
 * The source of truth is env vars (`lib/ops/flags.ts`). This module is a thin
 * read-only adapter that:
 *   1. Converts a `WriteGateResult` with `reason === "paused"` into a complete
 *      `CapabilityPauseDetail` ready to embed in any HTTP response body.
 *   2. Builds an `ApiErrorResult` that carries the pause detail under
 *      `error.pauseDetail` so an autonomous agent never has to parse prose.
 *
 * Why live here and not in `lib/ops/flags.ts`?
 *
 * `lib/ops/flags.ts` is imported by workers and scripts that must not pull in
 * `lib/api/errors.ts` (which uses `import "server-only"` via the api-validation
 * chain). Keeping the ApiError wiring here avoids that dependency and keeps both
 * modules narrow.
 */

import "server-only";

import {
  type CapabilityPauseDetail,
  type Pausable,
  buildPauseDetail,
  checkWriteAllowed,
  pauseState,
  type Feature,
} from "../ops/flags";
import { apiError, type ApiErrorResult } from "../api/errors";

export type { CapabilityPauseDetail };

/**
 * Look up the pause state for a capability and return a structured
 * `CapabilityPauseDetail`, or `null` if the capability is not currently paused.
 *
 * This is the canonical read path for every API layer that wants to embed pause
 * information in an error body. It reads the same env vars `pauseState()` reads,
 * so it is always consistent with `checkWriteAllowed`.
 */
export function getCapabilityPauseDetail(
  capability: Pausable,
  env: Record<string, string | undefined> = process.env,
): CapabilityPauseDetail | null {
  const state = pauseState(capability, env);
  if (!state.paused) return null;
  return buildPauseDetail(capability, state, env);
}

/**
 * Build an `ApiErrorResult` for a paused capability.
 *
 * The `error` body is the standard `agent_paused` code (retryable, 303,
 * 300 s retry-after) extended with:
 *   - `capability`  — the exact capability that was paused
 *   - `viaGlobal`   — true when the whole platform is down, not one capability
 *   - `pausedAt`    — epoch ms if the operator set `MIMIR_PAUSE_<CAP>_AT`
 *
 * This keeps every pause-driven 403 body schema-identical so a client library
 * only needs one response-handling path.
 */
export function pausedCapabilityError(
  detail: CapabilityPauseDetail,
  retryAfterSeconds = 300,
): ApiErrorResult {
  const base = apiError("agent_paused", detail.reason, { retryAfterSeconds });
  // Augment the body in-place. The shape is still a valid ApiError — we're only
  // adding structured fields alongside the standard ones.
  const extended = {
    ...base,
    body: {
      error: {
        ...base.body.error,
        capability: detail.capability,
        viaGlobal: detail.viaGlobal,
        ...(detail.pausedAt !== undefined ? { pausedAt: detail.pausedAt } : {}),
      },
    },
  };
  return extended;
}

/**
 * Gate a write and, if blocked by a pause, return a ready-to-use
 * `ApiErrorResult`. Returns `null` when the write is allowed.
 *
 * Combines `checkWriteAllowed` + `pausedCapabilityError` into one call so a
 * route does not have to thread the raw `WriteGateResult` through three steps.
 *
 * Example:
 *   const blocked = gateOrPause({ capability: "stake" });
 *   if (blocked) return Response.json(blocked.body, { status: blocked.status });
 */
export function gateOrPause(
  args: { feature?: Feature; capability: Pausable; category?: string },
  env: Record<string, string | undefined> = process.env,
): ApiErrorResult | null {
  const gate = checkWriteAllowed(args, env);
  if (gate.allowed) return null;

  if (gate.reason === "paused" && gate.pauseDetail) {
    return pausedCapabilityError(gate.pauseDetail);
  }

  // feature_disabled or category_disabled: a 503 is wrong for these; they are
  // permanent (until configuration changes) and retrying cannot help.
  if (gate.reason === "feature_disabled") {
    return apiError("forbidden", gate.detail ?? "feature not enabled");
  }
  if (gate.reason === "category_disabled") {
    return apiError("forbidden", gate.detail ?? "category disabled");
  }

  // Unreachable if WriteBlockReason is exhaustive, but keeps TypeScript happy.
  return apiError("forbidden", gate.detail ?? "write not allowed");
}
