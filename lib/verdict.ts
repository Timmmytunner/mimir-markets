/**
 * Verdict — canonical settlement outcome for a Mimir claim.
 *
 * This module is the single source of truth for:
 *   - The four on-chain verdict strings the contract accepts.
 *   - The structured VerdictPayload shape the LLM must emit.
 *   - Runtime type guards and validation helpers consumed by every parser in
 *     the oracle and council pipelines.
 *
 * Design note: we deliberately avoid pulling in a runtime schema library
 * (Zod, Valibot, etc.) so this module stays importable in both the Next.js
 * edge runtime and the bare-Node agent workers without any bundler shims.
 * The validation surface is small and well-bounded — every field is checked
 * explicitly below and the tests in tests/node/verdict-parser.test.ts cover
 * all branches.
 */

// ── Core verdict enum ─────────────────────────────────────────────────────────

/** The four settlement outcomes the Mimir contract accepts. */
export const VERDICTS = [
  "CREATOR_WINS",
  "CHALLENGERS_WIN",
  "DRAW",
  "UNRESOLVABLE",
] as const;

export type Verdict = (typeof VERDICTS)[number];

/** Decisive verdicts that move money to one side. */
export const DECISIVE_VERDICTS = ["CREATOR_WINS", "CHALLENGERS_WIN"] as const satisfies readonly Verdict[];
export type DecisiveVerdict = (typeof DECISIVE_VERDICTS)[number];

/** Non-decisive outcomes: the contract refunds or splits. */
export const NON_DECISIVE_VERDICTS = ["DRAW", "UNRESOLVABLE"] as const satisfies readonly Verdict[];
export type NonDecisiveVerdict = (typeof NON_DECISIVE_VERDICTS)[number];

export function isVerdict(value: unknown): value is Verdict {
  return typeof value === "string" && (VERDICTS as readonly string[]).includes(value);
}

export function isDecisiveVerdict(value: unknown): value is DecisiveVerdict {
  return typeof value === "string" && (DECISIVE_VERDICTS as readonly string[]).includes(value);
}

// ── Structured LLM payload ────────────────────────────────────────────────────

/**
 * The exact JSON shape the LLM is asked to produce at every settlement
 * boundary (oracle solo, oracle reference assessment, and council persona
 * votes).  Every consumer that parses LLM text should validate against this
 * interface using `parseVerdictPayload`.
 *
 * Money fields are intentionally absent: USDC amounts, wallet addresses,
 * and analytics fields are never placed inside the LLM-controlled payload
 * — they live in the surrounding settlement context so the model cannot
 * influence them.
 */
export interface VerdictPayload {
  verdict:     Verdict;
  /** Integer 0–100. The LLM's self-reported confidence in this verdict. */
  confidence:  number;
  /** Human-readable explanation, capped to 500 chars on output. */
  explanation: string;
}

// ── Validation result ─────────────────────────────────────────────────────────

export type VerdictParseOk = {
  ok: true;
  payload: VerdictPayload;
};

export type VerdictParseError = {
  ok: false;
  /**
   * Machine-readable reason code, used by the oracle to decide whether
   * to retry, fall back, or reject permanently.
   *
   *  invalid-json       — extractJson returned null, or JSON.parse threw.
   *  invalid-verdict    — verdict field present but not a known VERDICTS member.
   *  missing-verdict    — verdict field absent or non-string.
   *  duplicate          — same claim already has a settled on-chain verdict
   *                       (guards the poll loop against double-settlement).
   *  stale              — the claim deadline is in the future; settlement
   *                       was triggered too early.
   *  cancelled          — claim state is "cancelled"; must not be settled.
   *  dependency-failure — a required upstream step (evidence fetch, council
   *                       quorum, etc.) failed and the oracle cannot proceed
   *                       without it for this claim.
   */
  reason:
    | "invalid-json"
    | "invalid-verdict"
    | "missing-verdict"
    | "duplicate"
    | "stale"
    | "cancelled"
    | "dependency-failure";
  /** Developer-readable detail, never surfaced to end users. */
  detail: string;
};

export type VerdictParseResult = VerdictParseOk | VerdictParseError;

// ── Low-level field validators ────────────────────────────────────────────────

/**
 * Validate and normalise a raw parsed object into a `VerdictPayload`.
 *
 * - `verdict` must be one of the four known strings (case-sensitive).
 * - `confidence` is coerced: string "80" is accepted and rounded; out-of-range
 *   values are clamped to [0, 100].
 * - `explanation` defaults to "" when absent; truncated to 500 chars.
 *
 * Returns `null` on hard failure (bad verdict string), or the normalised
 * payload on success.
 */
export function validateVerdictFields(raw: unknown): VerdictPayload | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;

  // Verdict: mandatory, must be a known string.
  const verdictRaw = obj["verdict"];
  if (!isVerdict(verdictRaw)) return null;

  // Confidence: optional numeric field — coerce string digits, clamp range.
  let confidence = 50; // safe default
  if (obj["confidence"] !== undefined && obj["confidence"] !== null) {
    const raw = Number(obj["confidence"]);
    confidence = Number.isFinite(raw) ? Math.max(0, Math.min(100, Math.round(raw))) : 50;
  }

  // Explanation: optional string, defaults to empty.
  const explanation = typeof obj["explanation"] === "string"
    ? obj["explanation"].slice(0, 500)
    : "";

  return { verdict: verdictRaw, confidence, explanation };
}

// ── Settlement-guard helpers ──────────────────────────────────────────────────

/**
 * Claim state constraints that must pass before the oracle writes to chain.
 * These are checked in `parseVerdictPayload` when `guardContext` is provided,
 * so the settlement guards and the LLM parse share a single code path.
 */
export interface VerdictGuardContext {
  /** Current on-chain state of the claim. */
  claimState: "open" | "active" | "resolved" | "cancelled";
  /** Unix seconds — claim deadline. */
  deadline: number;
  /** Unix seconds — current time (injectable for tests). Defaults to Date.now()/1000. */
  nowSecs?: number;
}

/**
 * Check settlement pre-conditions and return an error result if any guard
 * fails.  Returns `null` (no problem found) when the claim is settleable.
 *
 *  cancelled  — claim.state === "cancelled"; the contract would reject this.
 *  duplicate  — claim.state === "resolved"; already settled.
 *  stale      — deadline > now; oracle must not settle before the deadline.
 */
export function checkSettlementGuards(ctx: VerdictGuardContext): VerdictParseError | null {
  const now = ctx.nowSecs ?? Math.floor(Date.now() / 1000);

  if (ctx.claimState === "cancelled") {
    return {
      ok: false,
      reason: "cancelled",
      detail: `Claim is in state 'cancelled' and cannot be settled.`,
    };
  }

  if (ctx.claimState === "resolved") {
    return {
      ok: false,
      reason: "duplicate",
      detail: `Claim is already resolved (state='resolved'). Skipping to avoid double-settlement.`,
    };
  }

  if (ctx.deadline > now) {
    return {
      ok: false,
      reason: "stale",
      detail: `Claim deadline ${ctx.deadline} is in the future (now=${now}). Too early to settle.`,
    };
  }

  return null;
}

// ── Primary entry point ───────────────────────────────────────────────────────

/**
 * Parse and validate a raw LLM text response into a typed `VerdictPayload`.
 *
 * Steps:
 *  1. Run `extractJson` to pull the first balanced JSON object from the text.
 *  2. `JSON.parse` the extracted string.
 *  3. `validateVerdictFields` to normalise and type-check.
 *  4. Optionally run settlement guards when `guardContext` is supplied.
 *
 * @param rawText  - The full LLM response string (may be prose, fenced, etc.)
 * @param extractor - `extractJson` function (injected to avoid a circular dep
 *                    on lib/llm from lib/verdict).
 * @param guardContext - Optional claim-state context for settlement guards.
 */
export function parseVerdictPayload(
  rawText: string,
  extractor: (text: string) => string | null,
  guardContext?: VerdictGuardContext,
): VerdictParseResult {
  // ── Settlement guards (pre-parse, independent of LLM output) ─────────────
  if (guardContext) {
    const guardErr = checkSettlementGuards(guardContext);
    if (guardErr) return guardErr;
  }

  // ── JSON extraction ───────────────────────────────────────────────────────
  const jsonStr = extractor(rawText);
  if (!jsonStr) {
    return {
      ok: false,
      reason: "invalid-json",
      detail: `extractJson returned null. Raw prefix: ${rawText.slice(0, 120)}`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (err) {
    return {
      ok: false,
      reason: "invalid-json",
      detail: `JSON.parse threw: ${err instanceof Error ? err.message : String(err)}. Extracted: ${jsonStr.slice(0, 120)}`,
    };
  }

  // ── Field validation ──────────────────────────────────────────────────────
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: false,
      reason: "invalid-json",
      detail: `Parsed value is not an object (type=${typeof parsed}).`,
    };
  }

  const obj = parsed as Record<string, unknown>;
  // Distinguish "verdict field absent" from "verdict field present but wrong"
  // so callers can choose different retry strategies.
  if (!("verdict" in obj) || typeof obj["verdict"] !== "string") {
    return {
      ok: false,
      reason: "missing-verdict",
      detail: `'verdict' field is absent or not a string. Keys found: [${Object.keys(obj).join(", ")}]`,
    };
  }

  const payload = validateVerdictFields(parsed);
  if (!payload) {
    return {
      ok: false,
      reason: "invalid-verdict",
      detail: `verdict '${String(obj["verdict"])}' is not one of [${VERDICTS.join(", ")}].`,
    };
  }

  return { ok: true, payload };
}

// ── Dependency-failure helper ─────────────────────────────────────────────────

/**
 * Constructs a `VerdictParseError` with reason `"dependency-failure"`.
 *
 * Use this when a required upstream step (evidence fetch, council quorum,
 * LLM API call, etc.) failed and the oracle cannot produce a trustworthy
 * verdict for this settlement cycle.  The poll loop should skip the claim
 * and retry next round rather than defaulting to UNRESOLVABLE on-chain.
 */
export function dependencyFailure(detail: string): VerdictParseError {
  return { ok: false, reason: "dependency-failure", detail };
}
