import assert from "node:assert/strict";
import test from "node:test";

import {
  buildVSCacheFreshness,
  isStaleIndexSnapshot,
  makeContractFreshness,
} from "../../lib/vs-freshness";

const windowMs = 60_000;

test("warns only when an indexed snapshot crosses the stale boundary", () => {
  const cached = buildVSCacheFreshness({
    updatedAtMs: Date.now() - windowMs * 2,
    freshnessWindowMs: windowMs,
    source: "index",
  });
  assert.ok(cached.lastUpdatedAt);
  const updatedAtMs = Date.parse(cached.lastUpdatedAt);
  assert.equal(cached.status, "cached");
  assert.equal(isStaleIndexSnapshot(cached, updatedAtMs + windowMs * 5), false);
  assert.equal(isStaleIndexSnapshot(cached, updatedAtMs + windowMs * 5 + 1), true);
});

test("warns for an index with no usable update time", () => {
  const unknown = buildVSCacheFreshness({
    updatedAtMs: null,
    freshnessWindowMs: windowMs,
    source: "index",
  });
  assert.equal(isStaleIndexSnapshot(unknown), true);
  assert.equal(isStaleIndexSnapshot({ ...unknown, status: "cached" }), true);
  assert.equal(isStaleIndexSnapshot({ ...unknown, status: "cached", lastUpdatedAt: "invalid" }), true);
  assert.equal(isStaleIndexSnapshot({ ...unknown, status: "cached", lastUpdatedAt: new Date().toISOString(), freshnessWindowMs: 0 }), true);
});

test("does not warn for live contract reads or unavailable metadata", () => {
  assert.equal(isStaleIndexSnapshot(makeContractFreshness()), false);
  assert.equal(isStaleIndexSnapshot({ ...makeContractFreshness(), status: "stale" }), false);
  assert.equal(isStaleIndexSnapshot(null), false);
});
