import assert from "node:assert/strict";
import test from "node:test";

import {
  beginAsyncPanelLoad,
  canCommitAsyncPanelPayload,
  createAsyncPanelState,
  markAsyncPanelStale,
  settleAsyncPanelLoad,
  shouldShowAsyncPanelSkeleton,
} from "../../lib/asyncPanelLoading";

test("positive: loading then ready commits payload for matching generation", () => {
  let state = createAsyncPanelState("market");
  state = beginAsyncPanelLoad(state, {
    key: "claim:85",
    generation: 1,
    dependencyKey: "wallet:ok",
  });
  assert.equal(state.phase, "loading");
  assert.equal(shouldShowAsyncPanelSkeleton(state), true);
  assert.equal(canCommitAsyncPanelPayload(state, "claim:85", 1), true);

  state = settleAsyncPanelLoad(state, {
    requestKey: "claim:85",
    generation: 1,
    atMs: 1_000,
  });
  assert.equal(state.phase, "ready");
  assert.equal(shouldShowAsyncPanelSkeleton(state), false);
});

test("negative: missing dependency fails closed without skeleton commit path", () => {
  let state = createAsyncPanelState("dashboard");
  state = beginAsyncPanelLoad(state, {
    key: "dashboard:main",
    generation: 1,
    dependencyKey: null,
  });
  assert.equal(state.phase, "dependency_failure");
  assert.equal(shouldShowAsyncPanelSkeleton(state), false);
  assert.equal(canCommitAsyncPanelPayload(state, "dashboard:main", 1), false);
});

test("boundary: empty request key is invalid", () => {
  let state = createAsyncPanelState("explorer");
  state = beginAsyncPanelLoad(state, {
    key: "   ",
    generation: 2,
    dependencyKey: "filters",
  });
  assert.equal(state.phase, "invalid");
  assert.equal(state.reason, "invalid_request_key");
});

test("regression: cancelled and stale generations cannot clobber ready data", () => {
  let state = createAsyncPanelState("council");
  state = beginAsyncPanelLoad(state, {
    key: "council:42",
    generation: 1,
    dependencyKey: "chain",
  });
  state = settleAsyncPanelLoad(state, {
    requestKey: "council:42",
    generation: 1,
    atMs: 5_000,
  });
  assert.equal(state.phase, "ready");

  // Supersede with a new fetch.
  state = beginAsyncPanelLoad(state, {
    key: "council:42",
    generation: 2,
    dependencyKey: "chain",
  });
  assert.equal(state.phase, "loading");

  // Late gen-1 response must not win.
  const afterStale = settleAsyncPanelLoad(state, {
    requestKey: "council:42",
    generation: 1,
    atMs: 6_000,
  });
  assert.equal(afterStale.phase, "loading");
  assert.equal(afterStale.generation, 2);

  // Cancel active gen-2.
  state = settleAsyncPanelLoad(state, {
    requestKey: "council:42",
    generation: 2,
    atMs: 7_000,
    cancelled: true,
  });
  assert.equal(state.phase, "cancelled");
  assert.equal(canCommitAsyncPanelPayload(state, "council:42", 2), false);
});

test("duplicated in-flight submit is marked without dropping the skeleton", () => {
  let state = createAsyncPanelState("market");
  state = beginAsyncPanelLoad(state, {
    key: "claim:1",
    generation: 3,
    dependencyKey: "rpc",
  });
  state = beginAsyncPanelLoad(state, {
    key: "claim:1",
    generation: 3,
    dependencyKey: "rpc",
  });
  assert.equal(state.phase, "duplicated");
  assert.equal(shouldShowAsyncPanelSkeleton(state), true);
});

test("stale marker fires after freshness window", () => {
  let state = createAsyncPanelState("dashboard");
  state = beginAsyncPanelLoad(state, {
    key: "dash",
    generation: 1,
    dependencyKey: "snap",
  });
  state = settleAsyncPanelLoad(state, {
    requestKey: "dash",
    generation: 1,
    atMs: 10_000,
  });
  const stillFresh = markAsyncPanelStale(state, 20_000, 30_000);
  assert.equal(stillFresh.phase, "ready");
  const stale = markAsyncPanelStale(state, 50_000, 30_000);
  assert.equal(stale.phase, "stale");
});
