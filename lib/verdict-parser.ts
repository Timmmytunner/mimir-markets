/**
 * Verdict parser — the single integration point between raw LLM text and the
 * typed `VerdictPayload` that the oracle writes to chain.
 *
 * Responsibilities
 * ────────────────
 * 1. Validate extracted JSON's shape and field values.
 * 2. Run settlement guards (cancelled / duplicate / stale) before spending gas.
 * 3. Retry once with a hardened prompt nudge when the first attempt is malformed.
 * 4. Surface structured `VerdictParseResult` values so every error branch is
 *    handled explicitly by callers rather than swallowed into a generic catch.
 *
 * What this module deliberately does NOT do
 * ──────────────────────────────────────────
 * - It does NOT import from lib/llm. The `extractJson` function is injected by
 *   callers (oracle, persona-llm) so this module has no SDK dependencies and is
 *   fully unit-testable in isolation.
 * - It never calls the LLM. Prompt construction and throttling stay in the
 *   oracle / persona-llm call sites.
 * - It never writes to chain. `resolveClaim` is called by the oracle after
 *   it has applied `tierVerdict` and `applyFetcherTrust` on top of the result.
 * - It never touches money fields (USDC amounts, wallet addresses, analytics).
 *
 * Edge-case catalogue (mirrored in tests/node/verdict-parser.test.ts)
 * ────────────────────────────────────────────────────────────────────
 *  invalid-json       LLM returned prose / markdown / truncated JSON.
 *  invalid-verdict    JSON parsed but verdict string not in VERDICTS enum.
 *  missing-verdict    JSON parsed but verdict field absent or not a string.
 *  stale              Claim deadline is still in the future.
 *  duplicate          Claim is already resolved on-chain.
 *  cancelled          Claim was cancelled; contract would reject the call.
 *  dependency-failure Evidence fetch failed, council below quorum, or other
 *                     upstream step that makes a verdict untrustworthy.
 */

import {
  parseVerdictPayload,
  dependencyFailure,
  type VerdictPayload,
  type VerdictParseResult,
  type VerdictParseError,
  type VerdictGuardContext,
} from "./verdict";

export type { VerdictPayload, VerdictParseResult, VerdictParseError, VerdictGuardContext };

// Re-export helpers callers commonly need alongside the parser.
export { dependencyFailure } from "./verdict";

// ── JSON schema for Gemini structured-output requests ────────────────────────
//
// Passing this as `jsonSchema` to `callLLM` instructs Gemini to use its
// native structured-output mode (`responseMimeType: "application/json"` +
// `responseSchema`).  Without it the model occasionally returns prose even
// when `jsonOnly: true` is set — observed in prod on stock/sports claims.
//
// Exported so oracle and persona-llm can share the identical schema without
// redefining it inline.
export const VERDICT_LLM_SCHEMA = {
  type: "object",
  properties: {
    verdict: {
      type: "string",
      enum: ["CREATOR_WINS", "CHALLENGERS_WIN", "DRAW", "UNRESOLVABLE"],
    },
    confidence: { type: "integer" },
    explanation: { type: "string" },
  },
  required: ["verdict", "confidence", "explanation"],
} as const;

// ── Retry prompt suffix ───────────────────────────────────────────────────────
//
// Appended on the second attempt when the first LLM response was unparseable.
// Keeping it here (rather than inline at each call site) ensures every retry
// path uses the same hardened nudge.
export const VERDICT_RETRY_SUFFIX =
  '\n\nCRITICAL: Output ONLY the raw JSON object. Do NOT restate the question, ' +
  'do NOT explain your reasoning outside the "explanation" field, do NOT use ' +
  'markdown or bullet lists. Your entire response must start with { and end with }.';

// ── Extractor type ────────────────────────────────────────────────────────────

/**
 * A function that extracts the first balanced JSON object (or array) from
 * a raw string — typically LLM output that may include prose, fences, etc.
 * Returns `null` when no valid JSON structure is found.
 *
 * The production implementation is `extractJson` from `lib/llm`.  Tests may
 * inject a simpler stub — this type makes the injection contract explicit.
 */
export type JsonExtractor = (text: string) => string | null;

// ── Primary parse helper ──────────────────────────────────────────────────────

/**
 * Parse one LLM response text into a `VerdictParseResult`.
 *
 * Delegates to `parseVerdictPayload` in `lib/verdict.ts`, using the supplied
 * `extractor` to pull JSON out of raw LLM text.  Call sites pass `guardContext`
 * when settling a specific claim so the cancelled / duplicate / stale guards
 * run before any chain write.
 *
 * @param rawText  - The full LLM response string (may be prose, fenced, etc.)
 * @param extractor - JSON extraction function (inject `extractJson` from lib/llm
 *                    at call sites; inject a stub in tests).
 * @param guardContext - Optional claim-state context for settlement guards.
 *
 * @example
 * ```ts
 * import { extractJson } from "./llm";
 * import { parseVerdictText } from "./verdict-parser";
 *
 * const result = parseVerdictText(llmText, extractJson, {
 *   claimState: claim.state,
 *   deadline:   claim.deadline,
 * });
 * if (!result.ok) { ... handle error ... }
 * const { verdict, confidence, explanation } = result.payload;
 * ```
 */
export function parseVerdictText(
  rawText: string,
  extractor: JsonExtractor,
  guardContext?: VerdictGuardContext,
): VerdictParseResult {
  return parseVerdictPayload(rawText, extractor, guardContext);
}

// ── Two-attempt parse (used by the oracle's evaluateClaim) ───────────────────

/**
 * Parse options for `parseLLMVerdictWithRetry`.
 */
export interface ParseWithRetryOptions {
  /**
   * JSON extraction function (e.g. `extractJson` from `lib/llm`).
   * Injected so this module remains SDK-free and testable.
   */
  extractor: JsonExtractor;
  /**
   * Function that produces the LLM prompt for a given attempt number (1 or 2).
   * On attempt 2 the caller should append `VERDICT_RETRY_SUFFIX` to the base
   * prompt — this factory keeps that logic at the call site where the full
   * prompt context lives.
   */
  buildPrompt: (attempt: number) => string;
  /**
   * Async function that calls the LLM and returns the raw text response.
   * Injected so this module stays pure and testable without network mocks.
   */
  callLLMFn: (prompt: string) => Promise<string>;
  /** Optional settlement guard context — same as in `parseVerdictText`. */
  guardContext?: VerdictGuardContext;
}

export interface ParseWithRetryResult {
  result: VerdictParseResult;
  /** The raw LLM text from the last attempt, for error logging. */
  lastRawText: string;
  /** Which attempt (1 or 2) succeeded, or 2 if both failed. */
  attempts: 1 | 2;
}

/**
 * Run up to two LLM calls, returning the first parseable verdict.
 *
 * Attempt 1 uses the base prompt.  If parsing fails with `invalid-json`,
 * `missing-verdict`, or `invalid-verdict`, attempt 2 is made.  Other failure
 * reasons (settlement guards: `stale`, `cancelled`, `duplicate`,
 * `dependency-failure`) are returned immediately — retrying with a different
 * prompt cannot fix a guard violation.
 *
 * The oracle's inline retry loop and the persona-llm fallback are both
 * replaced by this helper, which makes the retry semantics explicit and
 * identical everywhere.
 */
export async function parseLLMVerdictWithRetry(
  opts: ParseWithRetryOptions,
): Promise<ParseWithRetryResult> {
  // Settlement guards are prompt-independent; check before the first LLM call
  // to avoid burning an RPM slot on a claim that can never be settled.
  if (opts.guardContext) {
    const guardResult = parseVerdictText("", opts.extractor, opts.guardContext);
    if (!guardResult.ok) {
      return { result: guardResult, lastRawText: "", attempts: 1 };
    }
  }

  let lastRawText = "";

  for (let attempt = 1; attempt <= 2; attempt++) {
    const prompt = opts.buildPrompt(attempt);
    let rawText: string;
    try {
      rawText = await opts.callLLMFn(prompt);
    } catch (err) {
      // LLM call itself failed (network, API key, etc.) — this is a
      // dependency failure, not a parse error. Return immediately; a retry
      // with a different prompt won't fix a dead API connection.
      return {
        result: dependencyFailure(
          `LLM call failed on attempt ${attempt}: ${err instanceof Error ? err.message : String(err)}`,
        ),
        lastRawText: "",
        attempts: attempt as 1 | 2,
      };
    }

    lastRawText = rawText;
    const parsed = parseVerdictText(rawText, opts.extractor);

    if (parsed.ok) {
      return { result: parsed, lastRawText: rawText, attempts: attempt as 1 | 2 };
    }

    // Non-retryable reasons: guard violations and dependency failures.
    const retryable: VerdictParseError["reason"][] = [
      "invalid-json",
      "missing-verdict",
      "invalid-verdict",
    ];
    if (!retryable.includes(parsed.reason)) {
      return { result: parsed, lastRawText: rawText, attempts: attempt as 1 | 2 };
    }

    // Don't loop a third time — fall through to return after attempt 2.
  }

  // Both attempts failed to parse — return the last error.
  const finalResult = parseVerdictText(lastRawText, opts.extractor);
  return { result: finalResult, lastRawText, attempts: 2 };
}
