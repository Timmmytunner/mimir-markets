/**
 * tests/node/verdict-parser.test.ts
 *
 * Comprehensive coverage for the structured LLM verdict validation layer
 * introduced in lib/verdict.ts and lib/verdict-parser.ts (issue #95).
 *
 * Test groups
 * ───────────
 *  A. isVerdict / isDecisiveVerdict — type-guard primitives
 *  B. validateVerdictFields — field-level normalisation
 *  C. checkSettlementGuards — cancelled / duplicate / stale pre-conditions
 *  D. parseVerdictPayload — full parse pipeline (happy path + all error codes)
 *  E. parseVerdictText — integration wrapper with injected extractor
 *  F. parseLLMVerdictWithRetry — two-attempt async loop
 *  G. dependencyFailure — convenience constructor
 *  H. Regression fixtures from production failures
 *  I. VERDICT_LLM_SCHEMA shape
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  VERDICTS,
  isVerdict,
  isDecisiveVerdict,
  validateVerdictFields,
  checkSettlementGuards,
  parseVerdictPayload,
  dependencyFailure,
  type VerdictPayload,
  type VerdictGuardContext,
} from "../../lib/verdict";

import {
  parseVerdictText,
  parseLLMVerdictWithRetry,
  VERDICT_LLM_SCHEMA,
  VERDICT_RETRY_SUFFIX,
} from "../../lib/verdict-parser";

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Minimal extractJson stub: returns the first {...} block found via regex.
 * Handles fenced code blocks (strips the fence first) and prose wrappers.
 * Good enough for the cases tests need to exercise; the real extractJson in
 * lib/llm.ts has full balanced-brace walking.
 */
function stubExtract(text: string): string | null {
  // Strip ```json ... ``` fences
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  // Find first { ... } block
  const m = text.match(/\{[\s\S]*\}/);
  return m ? m[0] : null;
}

/** Identity extractor: text already IS the JSON string. */
function identityExtract(text: string): string | null {
  return text.trim() || null;
}

/** Always-null extractor: simulates extractJson finding no JSON. */
function nullExtract(_: string): string | null {
  return null;
}

function validPayload(overrides: Partial<VerdictPayload> = {}): VerdictPayload {
  return {
    verdict:     "CREATOR_WINS",
    confidence:  85,
    explanation: "The evidence clearly supports Side A.",
    ...overrides,
  };
}

/** Serialise a VerdictPayload to the JSON string the LLM might emit. */
function asLLMText(p: Partial<VerdictPayload> & { verdict?: unknown } = {}): string {
  return JSON.stringify({ ...validPayload(), ...p });
}

const PAST   = 1_000_000;  // fixed "now" for guard tests
const FUTURE = 2_000_000;

function ctx(overrides: Partial<VerdictGuardContext>): VerdictGuardContext {
  return {
    claimState: "active",
    deadline:   PAST - 3600,  // 1 hour in the past
    nowSecs:    PAST,
    ...overrides,
  };
}

// ── A. Type-guard primitives ──────────────────────────────────────────────────

test("isVerdict accepts all four canonical strings", () => {
  for (const v of VERDICTS) {
    assert.ok(isVerdict(v), `expected isVerdict("${v}") to be true`);
  }
});

test("isVerdict rejects near-misses and non-strings", () => {
  assert.equal(isVerdict("creator_wins"), false);    // wrong case
  assert.equal(isVerdict("CREATOR WINS"), false);    // space not underscore
  assert.equal(isVerdict(""), false);
  assert.equal(isVerdict(null), false);
  assert.equal(isVerdict(undefined), false);
  assert.equal(isVerdict(42), false);
  assert.equal(isVerdict({}), false);
  assert.equal(isVerdict("DRAW "), false);            // trailing space
});

test("isDecisiveVerdict is true only for the two money-moving sides", () => {
  assert.ok(isDecisiveVerdict("CREATOR_WINS"));
  assert.ok(isDecisiveVerdict("CHALLENGERS_WIN"));
  assert.equal(isDecisiveVerdict("DRAW"), false);
  assert.equal(isDecisiveVerdict("UNRESOLVABLE"), false);
  assert.equal(isDecisiveVerdict(""), false);
});

// ── B. validateVerdictFields ──────────────────────────────────────────────────

test("validateVerdictFields returns a normalised payload for a clean object", () => {
  const result = validateVerdictFields({
    verdict: "CHALLENGERS_WIN",
    confidence: 72,
    explanation: "Side B is right.",
  });
  assert.ok(result !== null);
  assert.equal(result!.verdict, "CHALLENGERS_WIN");
  assert.equal(result!.confidence, 72);
  assert.equal(result!.explanation, "Side B is right.");
});

test("validateVerdictFields returns null for an unknown verdict string", () => {
  assert.equal(validateVerdictFields({ verdict: "SIDE_A", confidence: 80, explanation: "x" }), null);
});

test("validateVerdictFields returns null for a non-object input", () => {
  assert.equal(validateVerdictFields(null), null);
  assert.equal(validateVerdictFields("CREATOR_WINS"), null);
  assert.equal(validateVerdictFields([]), null);
  assert.equal(validateVerdictFields(42), null);
});

test("validateVerdictFields clamps confidence to [0, 100]", () => {
  const lo = validateVerdictFields({ verdict: "DRAW", confidence: -50, explanation: "" });
  assert.equal(lo!.confidence, 0);
  const hi = validateVerdictFields({ verdict: "DRAW", confidence: 999, explanation: "" });
  assert.equal(hi!.confidence, 100);
});

test("validateVerdictFields rounds non-integer confidence", () => {
  const r = validateVerdictFields({ verdict: "DRAW", confidence: 77.8, explanation: "" });
  assert.equal(r!.confidence, 78);
});

test("validateVerdictFields coerces numeric string confidence", () => {
  const r = validateVerdictFields({ verdict: "DRAW", confidence: "80", explanation: "" });
  assert.equal(r!.confidence, 80);
});

test("validateVerdictFields defaults confidence to 50 when missing", () => {
  const r = validateVerdictFields({ verdict: "UNRESOLVABLE", explanation: "no data" });
  assert.equal(r!.confidence, 50);
});

test("validateVerdictFields defaults confidence to 50 when non-numeric", () => {
  const r = validateVerdictFields({ verdict: "UNRESOLVABLE", confidence: "high", explanation: "" });
  assert.equal(r!.confidence, 50);
});

test("validateVerdictFields defaults explanation to empty string when absent", () => {
  const r = validateVerdictFields({ verdict: "DRAW", confidence: 50 });
  assert.equal(r!.explanation, "");
});

test("validateVerdictFields truncates explanation to 500 chars", () => {
  const long = "x".repeat(600);
  const r = validateVerdictFields({ verdict: "DRAW", confidence: 50, explanation: long });
  assert.equal(r!.explanation.length, 500);
});

test("validateVerdictFields ignores extra unknown fields", () => {
  const r = validateVerdictFields({
    verdict: "CREATOR_WINS",
    confidence: 90,
    explanation: "ok",
    wallet: "G123",         // money field — must be silently ignored
    analytics: { foo: 1 },
  });
  assert.ok(r !== null);
  assert.equal(Object.keys(r!).sort().join(","), "confidence,explanation,verdict");
});

// ── C. checkSettlementGuards ──────────────────────────────────────────────────

test("checkSettlementGuards returns null for a normal settleable claim", () => {
  assert.equal(checkSettlementGuards(ctx({})), null);
});

test("checkSettlementGuards: cancelled => reason=cancelled", () => {
  const err = checkSettlementGuards(ctx({ claimState: "cancelled" }));
  assert.ok(err !== null);
  assert.equal(err!.reason, "cancelled");
  assert.equal(err!.ok, false);
});

test("checkSettlementGuards: resolved => reason=duplicate", () => {
  const err = checkSettlementGuards(ctx({ claimState: "resolved" }));
  assert.ok(err !== null);
  assert.equal(err!.reason, "duplicate");
});

test("checkSettlementGuards: deadline in future => reason=stale", () => {
  const err = checkSettlementGuards(ctx({ deadline: FUTURE }));
  assert.ok(err !== null);
  assert.equal(err!.reason, "stale");
  assert.ok(err!.detail.includes(String(FUTURE)));
});

test("checkSettlementGuards: deadline exactly now is NOT stale", () => {
  // deadline === nowSecs: the window just closed — settles immediately.
  const err = checkSettlementGuards(ctx({ deadline: PAST, nowSecs: PAST }));
  assert.equal(err, null);
});

test("checkSettlementGuards: open state with past deadline is settleable", () => {
  assert.equal(checkSettlementGuards(ctx({ claimState: "open" })), null);
});

test("checkSettlementGuards: cancelled takes priority over stale", () => {
  const err = checkSettlementGuards(ctx({ claimState: "cancelled", deadline: FUTURE }));
  assert.equal(err!.reason, "cancelled");
});

// ── D. parseVerdictPayload ────────────────────────────────────────────────────

test("parseVerdictPayload: happy path returns ok=true with normalised payload", () => {
  const text = asLLMText({ verdict: "CHALLENGERS_WIN", confidence: 88 });
  const r = parseVerdictPayload(text, identityExtract);
  assert.ok(r.ok);
  assert.equal(r.payload.verdict, "CHALLENGERS_WIN");
  assert.equal(r.payload.confidence, 88);
});

test("parseVerdictPayload: all four verdicts parse successfully", () => {
  for (const v of VERDICTS) {
    const text = JSON.stringify({ verdict: v, confidence: 75, explanation: "ok" });
    const r = parseVerdictPayload(text, identityExtract);
    assert.ok(r.ok, `verdict "${v}" should parse`);
    assert.equal(r.payload.verdict, v);
  }
});

test("parseVerdictPayload: no JSON => reason=invalid-json", () => {
  const r = parseVerdictPayload("The creator clearly wins based on the evidence.", nullExtract);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "invalid-json");
});

test("parseVerdictPayload: malformed JSON => reason=invalid-json", () => {
  const r = parseVerdictPayload("{verdict: CREATOR_WINS}", identityExtract);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "invalid-json");
});

test("parseVerdictPayload: JSON array instead of object => reason=invalid-json", () => {
  const r = parseVerdictPayload('["CREATOR_WINS", 80]', identityExtract);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "invalid-json");
});

test("parseVerdictPayload: null JSON value => reason=invalid-json", () => {
  const r = parseVerdictPayload("null", identityExtract);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "invalid-json");
});

test("parseVerdictPayload: verdict field absent => reason=missing-verdict", () => {
  const r = parseVerdictPayload('{"confidence":80,"explanation":"ok"}', identityExtract);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "missing-verdict");
});

test("parseVerdictPayload: verdict field is a number => reason=missing-verdict", () => {
  const r = parseVerdictPayload('{"verdict":1,"confidence":80,"explanation":"ok"}', identityExtract);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "missing-verdict");
});

test("parseVerdictPayload: verdict field is null => reason=missing-verdict", () => {
  const r = parseVerdictPayload('{"verdict":null,"confidence":80}', identityExtract);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "missing-verdict");
});

test("parseVerdictPayload: unknown verdict string => reason=invalid-verdict", () => {
  const r = parseVerdictPayload('{"verdict":"SIDE_A","confidence":80,"explanation":"x"}', identityExtract);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "invalid-verdict");
  assert.ok(r.detail.includes("SIDE_A"));
});

test("parseVerdictPayload: wrong-case verdict => reason=invalid-verdict", () => {
  const r = parseVerdictPayload('{"verdict":"creator_wins","confidence":80,"explanation":"x"}', identityExtract);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "invalid-verdict");
});

test("parseVerdictPayload: settlement guard fires before JSON parse", () => {
  // Pass raw prose (would fail JSON parse) with a cancelled guard — guard wins.
  const r = parseVerdictPayload(
    "Some prose",
    nullExtract,
    ctx({ claimState: "cancelled" }),
  );
  assert.equal(r.ok, false);
  assert.equal(r.reason, "cancelled");
});

test("parseVerdictPayload: stale guard fires and returns stale error", () => {
  const r = parseVerdictPayload(
    asLLMText(),
    identityExtract,
    ctx({ deadline: FUTURE }),
  );
  assert.equal(r.ok, false);
  assert.equal(r.reason, "stale");
});

test("parseVerdictPayload: duplicate guard fires before parse", () => {
  const r = parseVerdictPayload(
    asLLMText(),
    identityExtract,
    ctx({ claimState: "resolved" }),
  );
  assert.equal(r.ok, false);
  assert.equal(r.reason, "duplicate");
});

test("parseVerdictPayload: guard passes, then valid JSON => ok=true", () => {
  const r = parseVerdictPayload(
    asLLMText({ verdict: "DRAW", confidence: 50 }),
    identityExtract,
    ctx({}),
  );
  assert.ok(r.ok);
  assert.equal(r.payload.verdict, "DRAW");
});

// ── E. parseVerdictText ───────────────────────────────────────────────────────

test("parseVerdictText: happy path with prose wrapper via stubExtract", () => {
  // Simulates the Gemini output that preceded prod failures: JSON buried in prose.
  const llmOutput = `Sure, here is my verdict:\n{"verdict":"CREATOR_WINS","confidence":91,"explanation":"The evidence is clear."}\nHope that helps!`;
  const r = parseVerdictText(llmOutput, stubExtract);
  assert.ok(r.ok);
  assert.equal(r.payload.verdict, "CREATOR_WINS");
  assert.equal(r.payload.confidence, 91);
});

test("parseVerdictText: fenced JSON block parses correctly", () => {
  const llmOutput = "```json\n{\"verdict\":\"DRAW\",\"confidence\":55,\"explanation\":\"Tie.\"}\n```";
  const r = parseVerdictText(llmOutput, stubExtract);
  assert.ok(r.ok);
  assert.equal(r.payload.verdict, "DRAW");
});

test("parseVerdictText: bare JSON with no wrappers parses correctly", () => {
  const r = parseVerdictText('{"verdict":"UNRESOLVABLE","confidence":0,"explanation":"No data."}', identityExtract);
  assert.ok(r.ok);
  assert.equal(r.payload.verdict, "UNRESOLVABLE");
});

test("parseVerdictText: pure prose returns invalid-json", () => {
  const r = parseVerdictText("Based on the evidence, the creator wins.", nullExtract);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "invalid-json");
});

test("parseVerdictText: empty string returns invalid-json", () => {
  const r = parseVerdictText("", nullExtract);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "invalid-json");
});

test("parseVerdictText: truncated JSON returns invalid-json", () => {
  // Simulates a 512-token cap cutting off mid-string (the prod bug this feature fixes).
  const r = parseVerdictText(
    '{"verdict":"CREATOR_WINS","confidence":85,"explanation":"The evidence sho',
    identityExtract,
  );
  assert.equal(r.ok, false);
  assert.equal(r.reason, "invalid-json");
});

test("parseVerdictText: markdown bullet breakdown returns invalid-json", () => {
  // Observed in prod: Gemini restates the claim as bullets instead of JSON.
  const r = parseVerdictText(
    "## Analysis\n- The creator states X\n- Evidence shows Z\n**Verdict: Creator wins**",
    nullExtract,
  );
  assert.equal(r.ok, false);
  assert.equal(r.reason, "invalid-json");
});

test("parseVerdictText: JSON with extra top-level fields ignores them", () => {
  const r = parseVerdictText(
    '{"verdict":"CHALLENGERS_WIN","confidence":78,"explanation":"ok","wallet":"G123","price":0.001}',
    identityExtract,
  );
  assert.ok(r.ok);
  // wallet and price must NOT appear in the payload
  assert.equal(Object.keys(r.payload).sort().join(","), "confidence,explanation,verdict");
});

test("parseVerdictText with guard: cancelled claim short-circuits before parse", () => {
  const r = parseVerdictText(
    asLLMText({ verdict: "CREATOR_WINS", confidence: 90 }),
    identityExtract,
    ctx({ claimState: "cancelled" }),
  );
  assert.equal(r.ok, false);
  assert.equal(r.reason, "cancelled");
});

// ── F. parseLLMVerdictWithRetry ───────────────────────────────────────────────

test("parseLLMVerdictWithRetry: succeeds on attempt 1 and does not call LLM again", async () => {
  let calls = 0;
  const { result, attempts } = await parseLLMVerdictWithRetry({
    extractor: identityExtract,
    buildPrompt: (_) => "evaluate this claim",
    callLLMFn: async (_) => {
      calls++;
      return asLLMText({ verdict: "CREATOR_WINS", confidence: 90 });
    },
  });
  assert.ok(result.ok);
  assert.equal(result.payload.verdict, "CREATOR_WINS");
  assert.equal(attempts, 1);
  assert.equal(calls, 1);
});

test("parseLLMVerdictWithRetry: retries once on invalid-json and succeeds on attempt 2", async () => {
  let calls = 0;
  const { result, attempts } = await parseLLMVerdictWithRetry({
    extractor: identityExtract,
    buildPrompt: (attempt) => attempt === 2 ? "evaluate + JSON only" : "evaluate",
    callLLMFn: async (_) => {
      calls++;
      return calls === 1
        ? "The creator wins based on the evidence."   // no JSON
        : asLLMText({ verdict: "CREATOR_WINS", confidence: 82 });
    },
  });
  assert.ok(result.ok);
  assert.equal(result.payload.verdict, "CREATOR_WINS");
  assert.equal(attempts, 2);
  assert.equal(calls, 2);
});

test("parseLLMVerdictWithRetry: retries once on missing-verdict", async () => {
  let calls = 0;
  const { result, attempts } = await parseLLMVerdictWithRetry({
    extractor: identityExtract,
    buildPrompt: (_) => "p",
    callLLMFn: async (_) => {
      calls++;
      return calls === 1
        ? '{"confidence":80,"explanation":"ok"}'         // missing verdict
        : asLLMText({ verdict: "DRAW", confidence: 60 });
    },
  });
  assert.ok(result.ok);
  assert.equal(result.payload.verdict, "DRAW");
  assert.equal(calls, 2);
});

test("parseLLMVerdictWithRetry: retries once on invalid-verdict string", async () => {
  let calls = 0;
  const { result } = await parseLLMVerdictWithRetry({
    extractor: identityExtract,
    buildPrompt: (_) => "p",
    callLLMFn: async (_) => {
      calls++;
      return calls === 1
        ? '{"verdict":"WINNER_IS_CREATOR","confidence":80,"explanation":"x"}'  // invalid
        : asLLMText({ verdict: "CREATOR_WINS", confidence: 80 });
    },
  });
  assert.ok(result.ok);
  assert.equal(result.payload.verdict, "CREATOR_WINS");
  assert.equal(calls, 2);
});

test("parseLLMVerdictWithRetry: both attempts fail => returns error from last attempt", async () => {
  const { result, attempts, lastRawText } = await parseLLMVerdictWithRetry({
    extractor: nullExtract,
    buildPrompt: (_) => "p",
    callLLMFn: async (_) => "no json here at all",
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid-json");
  assert.equal(attempts, 2);
  assert.equal(lastRawText, "no json here at all");
});

test("parseLLMVerdictWithRetry: does NOT retry on guard-blocked (cancelled) claim", async () => {
  let calls = 0;
  const { result, attempts } = await parseLLMVerdictWithRetry({
    extractor: identityExtract,
    buildPrompt: (_) => "p",
    callLLMFn: async (_) => { calls++; return asLLMText(); },
    guardContext: ctx({ claimState: "cancelled" }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "cancelled");
  assert.equal(calls, 0);    // guard fires before any LLM call
  assert.equal(attempts, 1);
});

test("parseLLMVerdictWithRetry: does NOT retry on duplicate (resolved) claim", async () => {
  let calls = 0;
  const { result } = await parseLLMVerdictWithRetry({
    extractor: identityExtract,
    buildPrompt: (_) => "p",
    callLLMFn: async (_) => { calls++; return asLLMText(); },
    guardContext: ctx({ claimState: "resolved" }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "duplicate");
  assert.equal(calls, 0);
});

test("parseLLMVerdictWithRetry: does NOT retry on stale claim", async () => {
  let calls = 0;
  const { result } = await parseLLMVerdictWithRetry({
    extractor: identityExtract,
    buildPrompt: (_) => "p",
    callLLMFn: async (_) => { calls++; return asLLMText(); },
    guardContext: ctx({ deadline: FUTURE }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "stale");
  assert.equal(calls, 0);
});

test("parseLLMVerdictWithRetry: LLM throws => dependency-failure, no retry", async () => {
  let calls = 0;
  const { result, attempts } = await parseLLMVerdictWithRetry({
    extractor: identityExtract,
    buildPrompt: (_) => "p",
    callLLMFn: async (_) => {
      calls++;
      throw new Error("API_KEY_INVALID: 401");
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "dependency-failure");
  assert.ok(result.detail.includes("API_KEY_INVALID"));
  assert.equal(calls, 1);    // no retry after network/auth failure
  assert.equal(attempts, 1);
});

test("parseLLMVerdictWithRetry: passes attempt number 1 and 2 to buildPrompt", async () => {
  const seen: number[] = [];
  await parseLLMVerdictWithRetry({
    extractor: nullExtract,
    buildPrompt: (attempt) => { seen.push(attempt); return "p"; },
    callLLMFn: async (_) => "no json",
  });
  assert.deepEqual(seen, [1, 2]);
});

test("parseLLMVerdictWithRetry: VERDICT_RETRY_SUFFIX is appended on attempt 2", async () => {
  const prompts: string[] = [];
  const BASE = "base-prompt";
  await parseLLMVerdictWithRetry({
    extractor: nullExtract,
    buildPrompt: (attempt) => attempt === 1 ? BASE : `${BASE}${VERDICT_RETRY_SUFFIX}`,
    callLLMFn: async (p) => { prompts.push(p); return "no json"; },
  });
  assert.equal(prompts.length, 2);
  assert.equal(prompts[0], BASE);
  assert.ok(prompts[1].endsWith(VERDICT_RETRY_SUFFIX));
});

// ── G. dependencyFailure ──────────────────────────────────────────────────────

test("dependencyFailure returns a well-formed VerdictParseError", () => {
  const err = dependencyFailure("Evidence fetch timed out after 10s");
  assert.equal(err.ok, false);
  assert.equal(err.reason, "dependency-failure");
  assert.ok(err.detail.includes("Evidence fetch"));
});

test("dependencyFailure: reason field is the dependency-failure discriminant", () => {
  const err = dependencyFailure("quorum not reached");
  const reason: string = err.reason;
  assert.equal(reason, "dependency-failure");
});

// ── H. Regression fixtures ────────────────────────────────────────────────────
//
// These reproduce exact LLM output patterns that caused silent failures or
// wrong settlements in production before this feature was added.

test("regression: Gemini wraps JSON in conversational preamble", () => {
  // Gemini 1.5 Flash sometimes prefixes: "Sure! Here is the verdict:"
  const llm = `Sure! Here is the verdict:\n{"verdict":"CHALLENGERS_WIN","confidence":73,"explanation":"Side B is correct per the linked source."}\nLet me know if you need more details.`;
  const r = parseVerdictText(llm, stubExtract);
  assert.ok(r.ok, `expected ok but got: ${JSON.stringify(!r.ok && r)}`);
  assert.equal(r.payload.verdict, "CHALLENGERS_WIN");
});

test("regression: Gemini emits markdown bullet breakdown instead of JSON", () => {
  // Seen in prod on stock-price claims: model restates the claim as bullets.
  const llm = `## Verdict Analysis\n\n**Question:** Will AAPL close above $200?\n\n**Evidence:** Apple stock closed at $198.50.\n\n**Conclusion:** CHALLENGERS_WIN\n\n**Confidence:** 85`;
  const r = parseVerdictText(llm, nullExtract);
  // Correctly rejected — the model did not emit JSON.
  assert.equal(r.ok, false);
  assert.equal(r.reason, "invalid-json");
});

test("regression: 512-token cap truncates explanation mid-string", () => {
  // Old maxTokens:512 cut JSON here. Should fail cleanly, not throw.
  const truncated = `{"verdict":"CREATOR_WINS","confidence":85,"explanation":"The creator's position is supported by the linked article which states that the team won 3-`;
  const r = parseVerdictText(truncated, identityExtract);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "invalid-json");
});

test("regression: confidence sent as string '80' by some model variants", () => {
  // Some Anthropic responses stringify numbers inside JSON.
  const r = parseVerdictText('{"verdict":"DRAW","confidence":"80","explanation":"Equal evidence."}', identityExtract);
  assert.ok(r.ok);
  assert.equal(r.payload.confidence, 80);   // coerced to number
});

test("regression: confidence is 0 for UNRESOLVABLE (valid edge case)", () => {
  const r = parseVerdictText('{"verdict":"UNRESOLVABLE","confidence":0,"explanation":"No data available."}', identityExtract);
  assert.ok(r.ok);
  assert.equal(r.payload.verdict, "UNRESOLVABLE");
  assert.equal(r.payload.confidence, 0);
});

test("regression: explanation with braces inside string does not confuse stubExtract", () => {
  // The extractor must handle strings containing { and } without closing early.
  const r = parseVerdictText(
    '{"verdict":"CREATOR_WINS","confidence":90,"explanation":"The rule {win condition} was met."}',
    identityExtract,
  );
  assert.ok(r.ok);
  assert.ok(r.payload.explanation.includes("{win condition}"));
});

test("regression: LLM emits two JSON objects — first has no verdict => missing-verdict", () => {
  // Some chain-of-thought models emit a reasoning JSON then the answer JSON.
  // The extractor returns the first balanced object — which has no verdict field.
  // This is not a silent wrong settlement; it is an explicit missing-verdict error.
  const r = parseVerdictText(
    '{"reasoning":"creator wins"} {"verdict":"CHALLENGERS_WIN","confidence":60,"explanation":"Actually challengers."}',
    stubExtract,
  );
  assert.equal(r.ok, false);
  // The reasoning object has no verdict field.
  assert.equal(r.reason, "missing-verdict");
});

test("regression: money fields (wallet, price) in LLM response are stripped", () => {
  // The oracle must never let the LLM influence wallet addresses or fees.
  const r = parseVerdictText(
    '{"verdict":"CREATOR_WINS","confidence":90,"explanation":"ok","agent_owner_recipient":"GMALICIOUS","fee_bps":9999}',
    identityExtract,
  );
  assert.ok(r.ok);
  assert.equal(Object.keys(r.payload).sort().join(","), "confidence,explanation,verdict");
});

// ── I. VERDICT_LLM_SCHEMA shape ───────────────────────────────────────────────

test("VERDICT_LLM_SCHEMA has required fields for Gemini structured output", () => {
  assert.equal(VERDICT_LLM_SCHEMA.type, "object");
  assert.deepEqual([...VERDICT_LLM_SCHEMA.required].sort(), ["confidence", "explanation", "verdict"]);
  assert.deepEqual(
    [...VERDICT_LLM_SCHEMA.properties.verdict.enum],
    ["CREATOR_WINS", "CHALLENGERS_WIN", "DRAW", "UNRESOLVABLE"],
  );
  assert.equal(VERDICT_LLM_SCHEMA.properties.confidence.type, "integer");
  assert.equal(VERDICT_LLM_SCHEMA.properties.explanation.type, "string");
});
