import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_COUNCIL_QUORUM,
  MAX_COUNCIL_QUORUM,
  buildBallot,
  classifyVoteAttempt,
  evaluateQuorum,
  isDecisiveVerdict,
  isInvalidQuorumConfig,
  normalizeQuorum,
  shouldFallbackSolo,
  shouldUseCouncil,
  type ClassifiedVote,
  type VoteAttemptInput,
} from "../../lib/council/quorum";

function attempt(partial: Partial<VoteAttemptInput> & Pick<VoteAttemptInput, "slug">): VoteAttemptInput {
  return {
    claimId: 42,
    expectedClaimId: 42,
    claimState: "active",
    status: "ok",
    verdict: "CREATOR_WINS",
    confidence: 80,
    ...partial,
  };
}

function valid(
  slug: string,
  verdict: "CREATOR_WINS" | "CHALLENGERS_WIN" | "DRAW" | "UNRESOLVABLE" = "CREATOR_WINS",
): ClassifiedVote {
  return classifyVoteAttempt(attempt({ slug, verdict }));
}

// ── normalizeQuorum ───────────────────────────────────────────────────────────

test("normalizeQuorum keeps a positive integer", () => {
  assert.equal(normalizeQuorum(5), 5);
  assert.equal(normalizeQuorum("4"), 4);
});

test("normalizeQuorum defaults invalid values rather than disabling the gate", () => {
  // quorum 0 would accept an empty jury — that must never pass through.
  assert.equal(normalizeQuorum(0), DEFAULT_COUNCIL_QUORUM);
  assert.equal(normalizeQuorum(-1), DEFAULT_COUNCIL_QUORUM);
  assert.equal(normalizeQuorum(Number.NaN), DEFAULT_COUNCIL_QUORUM);
  assert.equal(normalizeQuorum("abc"), DEFAULT_COUNCIL_QUORUM);
  assert.equal(normalizeQuorum(undefined), DEFAULT_COUNCIL_QUORUM);
});

test("normalizeQuorum clamps absurd highs", () => {
  assert.equal(normalizeQuorum(999), MAX_COUNCIL_QUORUM);
});

test("isInvalidQuorumConfig treats missing as ok (use default) and junk as invalid", () => {
  assert.equal(isInvalidQuorumConfig(undefined), false);
  assert.equal(isInvalidQuorumConfig(""), false);
  assert.equal(isInvalidQuorumConfig(3), false);
  assert.equal(isInvalidQuorumConfig(0), true);
  assert.equal(isInvalidQuorumConfig("nope"), true);
});

// ── classifyVoteAttempt ───────────────────────────────────────────────────────

test("a well-formed decisive vote is valid", () => {
  const v = classifyVoteAttempt(attempt({ slug: "Optimist", verdict: "CHALLENGERS_WIN", confidence: 90 }));
  assert.equal(v.disposition, "valid");
  assert.equal(v.slug, "optimist");
  assert.equal(v.decisive, true);
  assert.equal(v.confidence, 90);
});

test("DRAW and UNRESOLVABLE are valid but not decisive", () => {
  const draw = classifyVoteAttempt(attempt({ slug: "a", verdict: "DRAW" }));
  const unr = classifyVoteAttempt(attempt({ slug: "b", verdict: "UNRESOLVABLE" }));
  assert.equal(draw.disposition, "valid");
  assert.equal(draw.decisive, false);
  assert.equal(unr.disposition, "valid");
  assert.equal(unr.decisive, false);
  assert.equal(isDecisiveVerdict("DRAW"), false);
});

test("missing slug or unknown verdict is invalid", () => {
  assert.equal(classifyVoteAttempt(attempt({ slug: "  " })).disposition, "invalid");
  assert.equal(
    classifyVoteAttempt(attempt({ slug: "optimist", verdict: "MAYBE" })).disposition,
    "invalid",
  );
});

test("cancelled claim marks every attempt cancelled", () => {
  const v = classifyVoteAttempt(attempt({ slug: "optimist", claimState: "cancelled" }));
  assert.equal(v.disposition, "cancelled");
  assert.equal(v.decisive, false);
});

test("resolved claim or mismatched claimId is stale", () => {
  assert.equal(
    classifyVoteAttempt(attempt({ slug: "optimist", claimState: "resolved" })).disposition,
    "stale",
  );
  assert.equal(
    classifyVoteAttempt(attempt({ slug: "optimist", claimId: 7, expectedClaimId: 42 })).disposition,
    "stale",
  );
});

test("age past maxAgeMs is stale", () => {
  const v = classifyVoteAttempt(
    attempt({ slug: "optimist", ageMs: 60_000, maxAgeMs: 10_000 }),
  );
  assert.equal(v.disposition, "stale");
});

test("network/timeout/5xx are dependency_failure; 4xx are invalid; 404 is stale", () => {
  assert.equal(
    classifyVoteAttempt(attempt({ slug: "a", status: "timeout" })).disposition,
    "dependency_failure",
  );
  assert.equal(
    classifyVoteAttempt(attempt({ slug: "b", status: "network_error" })).disposition,
    "dependency_failure",
  );
  assert.equal(
    classifyVoteAttempt(attempt({ slug: "c", status: "http_error", httpStatus: 502 })).disposition,
    "dependency_failure",
  );
  assert.equal(
    classifyVoteAttempt(attempt({ slug: "d", status: "http_error", httpStatus: 422 })).disposition,
    "invalid",
  );
  assert.equal(
    classifyVoteAttempt(attempt({ slug: "e", status: "http_error", httpStatus: 404 })).disposition,
    "stale",
  );
});

test("confidence outside 0..100 is clamped on valid votes", () => {
  const hi = classifyVoteAttempt(attempt({ slug: "a", confidence: 250 }));
  const lo = classifyVoteAttempt(attempt({ slug: "b", confidence: -5 }));
  assert.equal(hi.confidence, 100);
  assert.equal(lo.confidence, 0);
});

// ── buildBallot / duplicates ──────────────────────────────────────────────────

test("duplicate persona slugs: first valid wins, rest marked duplicated", () => {
  const { ballot, rejected } = buildBallot([
    valid("optimist", "CREATOR_WINS"),
    valid("optimist", "CHALLENGERS_WIN"),
    valid("doomer", "CREATOR_WINS"),
  ]);
  assert.equal(ballot.length, 2);
  assert.equal(ballot[0].verdict, "CREATOR_WINS");
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].disposition, "duplicated");
  assert.equal(rejected[0].decisive, false);
});

// ── evaluateQuorum ────────────────────────────────────────────────────────────

test("positive: enough decisive votes → use_council", () => {
  const eval_ = evaluateQuorum(
    [valid("a"), valid("b"), valid("c", "CHALLENGERS_WIN")],
    3,
    { claimState: "active" },
  );
  assert.equal(eval_.action, "use_council");
  assert.equal(eval_.decisiveCount, 3);
  assert.equal(shouldUseCouncil(eval_), true);
  assert.equal(shouldFallbackSolo(eval_), false);
});

test("negative: below quorum → fallback_solo with auditable reason", () => {
  const eval_ = evaluateQuorum([valid("a"), valid("b", "DRAW")], 3, { claimState: "open" });
  assert.equal(eval_.action, "fallback_solo");
  assert.equal(eval_.decisiveCount, 1);
  assert.match(eval_.reason, /below quorum/);
  assert.equal(shouldFallbackSolo(eval_), true);
});

test("boundary: decisive count exactly equal to quorum passes", () => {
  const votes = [valid("a"), valid("b"), valid("c")];
  const eval_ = evaluateQuorum(votes, 3);
  assert.equal(eval_.action, "use_council");
  assert.equal(eval_.decisiveCount, 3);
  assert.equal(eval_.quorum, 3);
});

test("cancelled claim aborts even if votes look decisive", () => {
  const eval_ = evaluateQuorum(
    [valid("a"), valid("b"), valid("c")],
    3,
    { claimState: "cancelled" },
  );
  assert.equal(eval_.action, "abort_cancelled");
  assert.equal(eval_.ballot.length, 0);
});

test("resolved claim aborts as stale settlement", () => {
  const eval_ = evaluateQuorum([valid("a")], 1, { claimState: "resolved" });
  assert.equal(eval_.action, "abort_resolved");
});

test("strict invalid quorum config aborts instead of normalizing", () => {
  const eval_ = evaluateQuorum([valid("a")], 0, { strictConfig: true });
  assert.equal(eval_.action, "abort_invalid_config");
});

test("dependency failures do not count as decisive and appear in fallback reason", () => {
  const attempts = [
    classifyVoteAttempt(attempt({ slug: "a", status: "timeout" })),
    classifyVoteAttempt(attempt({ slug: "b", status: "http_error", httpStatus: 503 })),
    valid("c"),
  ];
  const eval_ = evaluateQuorum(attempts, 3);
  assert.equal(eval_.action, "fallback_solo");
  assert.equal(eval_.decisiveCount, 1);
  assert.equal(eval_.dispositions.dependency_failure, 2);
  assert.match(eval_.reason, /dependency_failure/);
});

test("duplicates cannot pad the jury past quorum", () => {
  const attempts = [
    valid("optimist"),
    valid("optimist"),
    valid("optimist"),
    valid("doomer"),
  ];
  const eval_ = evaluateQuorum(attempts, 3);
  assert.equal(eval_.action, "fallback_solo");
  assert.equal(eval_.decisiveCount, 2);
  assert.equal(eval_.dispositions.duplicated, 2);
});

test("regression: empty jury never uses council", () => {
  const eval_ = evaluateQuorum([], DEFAULT_COUNCIL_QUORUM);
  assert.equal(eval_.action, "fallback_solo");
  assert.equal(eval_.decisiveCount, 0);
  assert.equal(shouldUseCouncil(eval_), false);
});
