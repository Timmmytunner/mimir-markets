/**
 * tests/node/vs-detail-refresh.test.ts
 *
 * Unit tests for the pure state-machine in lib/vs-detail-state.ts.
 * Coverage: positive, negative, boundary, and regression — issue #61.
 * No DOM or React renderer required.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  applyVsDetailFetchOutcome,
  beginVsDetailFetch,
  createVsDetailState,
  isValidVsId,
  resetVsDetailChallengeStake,
  resetVsDetailState,
  setVsDetailChallengeStake,
  VS_DETAIL_MAX_ATTEMPTS,
  VS_DETAIL_POLL_INTERVAL_MS,
} from "../../lib/vs-detail-state";
import type { VSData } from "../../lib/contract";

// ── Minimal VSData fixture ────────────────────────────────────────────────────

function makeVs(overrides: Partial<VSData> = {}): VSData {
  return {
    id: 42,
    question: "Will BTC close above $100k?",
    creator_position: "Yes",
    opponent_position: "No",
    creator: "GABC",
    opponent: "",
    stake_amount: 2,
    creator_stake: 2,
    total_challenger_stake: 0,
    reserved_creator_liability: 0,
    available_creator_liability: 2,
    deadline: Math.floor(Date.now() / 1000) + 86400,
    state: "open",
    winner: "",
    winner_side: undefined,
    resolution_url: "https://coingecko.com",
    resolution_summary: "",
    market_type: "binary",
    odds_mode: "pool",
    max_challengers: 1,
    challenger_count: 0,
    challengers: [],
    challenger_addresses: [],
    category: "crypto",
    challenger_payout_bps: 0,
    ...overrides,
  } as unknown as VSData;
}

// ── Constants ─────────────────────────────────────────────────────────────────

test("constants: poll interval is 10 s and max attempts is 12", () => {
  assert.equal(VS_DETAIL_POLL_INTERVAL_MS, 10_000);
  assert.equal(VS_DETAIL_MAX_ATTEMPTS, 12);
});

// ── isValidVsId ───────────────────────────────────────────────────────────────

test("positive: valid positive and negative integer vsIds are accepted", () => {
  assert.ok(isValidVsId(1));
  assert.ok(isValidVsId(42));
  assert.ok(isValidVsId(-4)); // sample/demo markets use negative ids
});

test("negative: NaN, 0, and non-integers are rejected", () => {
  assert.equal(isValidVsId(NaN), false);
  assert.equal(isValidVsId(0), false);
  assert.equal(isValidVsId(1.5), false);
  assert.equal(isValidVsId(Infinity), false);
});

// ── createVsDetailState ───────────────────────────────────────────────────────

test("positive: valid vsId starts in loading phase with all fields zeroed", () => {
  const state = createVsDetailState(42);
  assert.equal(state.phase, "loading");
  assert.equal(state.vs, null);
  assert.equal(state.cache, null);
  assert.equal(state.generation, 0);
  assert.equal(state.fetchAttempts, 0);
  assert.equal(state.refreshing, false);
  assert.equal(state.challengeStake, "");
  assert.equal(state.userHasSetStake, false);
});

test("negative: invalid vsId (NaN) starts in invalid phase", () => {
  assert.equal(createVsDetailState(NaN).phase, "invalid");
});

test("boundary: vsId of 0 is invalid", () => {
  assert.equal(createVsDetailState(0).phase, "invalid");
});

// ── beginVsDetailFetch ────────────────────────────────────────────────────────

test("positive: beginVsDetailFetch increments generation each call", () => {
  const s0 = createVsDetailState(42);
  const s1 = beginVsDetailFetch(s0);
  assert.equal(s1.generation, 1);
  assert.equal(s1.refreshing, false);

  const s2 = beginVsDetailFetch(s1, { isManual: true });
  assert.equal(s2.generation, 2);
  assert.equal(s2.refreshing, true);
});

// ── applyVsDetailFetchOutcome — success ───────────────────────────────────────

test("positive: success sets ready phase and resets attempt counter", () => {
  const s0 = createVsDetailState(42);
  const s1 = beginVsDetailFetch(s0);
  const vs = makeVs();

  const s2 = applyVsDetailFetchOutcome(s1, {
    kind: "success",
    generation: s1.generation,
    vs,
    cache: null,
  });

  assert.equal(s2.phase, "ready");
  assert.equal(s2.vs, vs);
  assert.equal(s2.fetchAttempts, 0);
  assert.equal(s2.refreshing, false);
});

test("positive: challengeStake auto-seeded from vs.stake_amount on first load", () => {
  const s0 = createVsDetailState(42);
  const s1 = beginVsDetailFetch(s0);

  const s2 = applyVsDetailFetchOutcome(s1, {
    kind: "success",
    generation: s1.generation,
    vs: makeVs({ stake_amount: 5 }),
    cache: null,
  });

  assert.equal(s2.challengeStake, "5");
  assert.equal(s2.userHasSetStake, false);
});

test("positive: user-typed stake is NOT overwritten by subsequent refreshes", () => {
  let state = createVsDetailState(42);
  state = setVsDetailChallengeStake(state, "10");
  state = beginVsDetailFetch(state);

  state = applyVsDetailFetchOutcome(state, {
    kind: "success",
    generation: state.generation,
    vs: makeVs({ stake_amount: 5 }),
    cache: null,
  });

  assert.equal(state.challengeStake, "10"); // user's value preserved
});

test("positive: stake not re-seeded on background polls after first load", () => {
  let state = createVsDetailState(42);

  // First load.
  state = beginVsDetailFetch(state);
  state = applyVsDetailFetchOutcome(state, {
    kind: "success",
    generation: state.generation,
    vs: makeVs({ stake_amount: 5 }),
    cache: null,
  });
  assert.equal(state.challengeStake, "5");

  // Second poll — vs.stake_amount is the same, but vs reference is not null.
  state = beginVsDetailFetch(state);
  state = applyVsDetailFetchOutcome(state, {
    kind: "success",
    generation: state.generation,
    vs: makeVs({ stake_amount: 5 }),
    cache: null,
  });
  assert.equal(state.challengeStake, "5");
});

// ── applyVsDetailFetchOutcome — generation guard ──────────────────────────────

test("regression: stale generation response is silently dropped", () => {
  const s0 = createVsDetailState(42);
  const s1 = beginVsDetailFetch(s0); // generation = 1
  const s2 = beginVsDetailFetch(s1); // generation = 2 supersedes s1

  const afterStale = applyVsDetailFetchOutcome(s2, {
    kind: "success",
    generation: 1, // old generation
    vs: makeVs(),
    cache: null,
  });

  // Must be reference-equal — no fields changed.
  assert.equal(afterStale, s2);
  assert.equal(afterStale.vs, null);
  assert.equal(afterStale.phase, "loading");
});

test("regression: error for a superseded generation is also dropped", () => {
  const s0 = createVsDetailState(42);
  const s1 = beginVsDetailFetch(s0);
  const s2 = beginVsDetailFetch(s1);

  const after = applyVsDetailFetchOutcome(s2, {
    kind: "error",
    generation: 1,
  });

  assert.equal(after, s2);
  assert.equal(after.fetchAttempts, 0);
});

// ── applyVsDetailFetchOutcome — empty path ────────────────────────────────────

test("positive: empty outcome with a pending VS shows pending while continuing poll", () => {
  const s0 = createVsDetailState(42);
  const s1 = beginVsDetailFetch(s0);
  const pending = makeVs();

  const s2 = applyVsDetailFetchOutcome(s1, {
    kind: "empty",
    generation: s1.generation,
    pending,
  });

  assert.equal(s2.vs, pending);
  assert.equal(s2.phase, "loading"); // not given up yet
  assert.equal(s2.fetchAttempts, 1);
});

test("boundary: exactly max attempts flips loading to not_found", () => {
  let state = createVsDetailState(42);

  for (let i = 0; i < VS_DETAIL_MAX_ATTEMPTS; i++) {
    state = beginVsDetailFetch(state);
    state = applyVsDetailFetchOutcome(state, {
      kind: "empty",
      generation: state.generation,
      pending: null,
    });
  }

  assert.equal(state.phase, "not_found");
  assert.equal(state.fetchAttempts, VS_DETAIL_MAX_ATTEMPTS);
});

test("boundary: max attempts with errors flips loading to dependency_failure", () => {
  let state = createVsDetailState(42);

  for (let i = 0; i < VS_DETAIL_MAX_ATTEMPTS; i++) {
    state = beginVsDetailFetch(state);
    state = applyVsDetailFetchOutcome(state, {
      kind: "error",
      generation: state.generation,
    });
  }

  assert.equal(state.phase, "dependency_failure");
});

test("regression: ready phase is never downgraded when later polls miss", () => {
  let state = createVsDetailState(42);

  // Successful first load.
  state = beginVsDetailFetch(state);
  state = applyVsDetailFetchOutcome(state, {
    kind: "success",
    generation: state.generation,
    vs: makeVs(),
    cache: null,
  });
  assert.equal(state.phase, "ready");

  // Hit max empty responses — phase must stay "ready".
  for (let i = 0; i < VS_DETAIL_MAX_ATTEMPTS; i++) {
    state = beginVsDetailFetch(state);
    state = applyVsDetailFetchOutcome(state, {
      kind: "empty",
      generation: state.generation,
      pending: null,
    });
  }

  assert.equal(state.phase, "ready");
});

// ── resetVsDetailState ────────────────────────────────────────────────────────

test("positive: resetVsDetailState wipes all fields for a new vsId", () => {
  let state = createVsDetailState(42);
  state = beginVsDetailFetch(state);
  state = applyVsDetailFetchOutcome(state, {
    kind: "success",
    generation: state.generation,
    vs: makeVs({ id: 42 }),
    cache: null,
  });
  state = setVsDetailChallengeStake(state, "99");

  const reset = resetVsDetailState(99);
  assert.equal(reset.vs, null);
  assert.equal(reset.phase, "loading");
  assert.equal(reset.generation, 0);
  assert.equal(reset.challengeStake, "");
  assert.equal(reset.userHasSetStake, false);
});

// ── setVsDetailChallengeStake / resetVsDetailChallengeStake ───────────────────

test("positive: setChallengeStake stores value and marks userHasSetStake", () => {
  const state = createVsDetailState(42);
  const next = setVsDetailChallengeStake(state, "7");
  assert.equal(next.challengeStake, "7");
  assert.equal(next.userHasSetStake, true);
});

test("positive: resetChallengeStake clears value and re-enables auto-seeding", () => {
  let state = createVsDetailState(42);
  state = setVsDetailChallengeStake(state, "7");
  state = resetVsDetailChallengeStake(state);
  assert.equal(state.challengeStake, "");
  assert.equal(state.userHasSetStake, false);

  // After reset, next success fetch should auto-seed.
  state = beginVsDetailFetch(state);
  state = applyVsDetailFetchOutcome(state, {
    kind: "success",
    generation: state.generation,
    vs: makeVs({ stake_amount: 3 }),
    cache: null,
  });
  assert.equal(state.challengeStake, "3");
});

// ── Cache freshness threading ─────────────────────────────────────────────────

test("positive: cache metadata from success outcome is preserved in state", () => {
  const s0 = createVsDetailState(42);
  const s1 = beginVsDetailFetch(s0);
  const cache = {
    source: "index" as const,
    status: "live" as const,
    lastUpdatedAt: new Date().toISOString(),
    ageMs: 500,
    freshnessWindowMs: 15_000,
  };

  const s2 = applyVsDetailFetchOutcome(s1, {
    kind: "success",
    generation: s1.generation,
    vs: makeVs(),
    cache,
  });

  assert.deepEqual(s2.cache, cache);
});
