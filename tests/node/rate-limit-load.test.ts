/**
 * Load-level coverage of the API rate limiter.
 *
 * `api-contract.test.ts` pins the decision semantics; this suite proves the
 * guard does not degrade when it is actually busy: thousands of keys and tens of
 * thousands of requests, exact limit enforcement, refusals that never move the
 * window forward, and a bounded bucket map under sustained key pressure.
 */

import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";

import {
  MAX_BUCKETS,
  bucketCount,
  consume,
  peek,
  resetRateLimits,
  type LimitRule,
  type RateLimitKeys,
} from "../../lib/api/rate-limit";

const NOW = 1_800_000_000_000;

beforeEach(() => resetRateLimits());

const rule = (dimension: LimitRule["dimension"], limit: number, windowMs = 60_000): LimitRule => ({
  dimension,
  limit,
  windowMs,
});

/** Deterministic key sets, so two runs can be compared byte-for-byte. */
const ip = (i: number): RateLimitKeys => ({ ip: `${(i % 250) + 1}.${(i >> 8) & 0xff}.${(i >> 16) & 0xff}.${i}` });
const agent = (i: number): RateLimitKeys => ({ agentId: `agent-${String(i).padStart(5, "0")}` });

test("each of a thousand keys gets its full allowance, exactly", () => {
  const rules = [rule("ip", 250)];
  // 1,000 distinct IPs * 250 requests each: every one within its limit.
  for (let i = 0; i < 1_000; i += 1) {
    assert.equal(bucketCount() <= MAX_BUCKETS, true);
    for (let n = 0; n < 250; n += 1) {
      const decision = consume(ip(i), rules, NOW);
      assert.equal(decision.allowed, true, `key ${i} request ${n} refused`);
      assert.equal(decision.remaining, 250 - n - 1);
    }
    // The very next one tips over — the limit is exact, not approximate.
    assert.equal(consume(ip(i), rules, NOW).allowed, false);
    assert.equal(consume(ip(i), rules, NOW).exceeded, "ip");
  }
  assert.equal(bucketCount(), 1_000);
});

test("distinct keys never share a bucket, so one cannot exhaust another's allowance", () => {
  const rules = [rule("agent", 3)];
  for (let i = 0; i < 300; i += 1) {
    assert.equal(consume(agent(i), rules, NOW).allowed, true);
    assert.equal(consume(agent(i), rules, NOW).allowed, true);
    assert.equal(consume(agent(i), rules, NOW).allowed, true);
  }
  // 300 agents are all at their cap — yet every one still owns its own window.
  assert.equal(bucketCount(), 300);
  for (let i = 0; i < 300; i += 1) {
    assert.equal(consume(agent(i), rules, NOW).allowed, false);
  }
  assert.equal(bucketCount(), 300);
});

test("refusals at scale neither grow the map nor postpone the reset", () => {
  const rules = [rule("ip", 120)];
  for (let i = 0; i < 500; i += 1) for (let n = 0; n < 120; n += 1) void consume(ip(i), rules, NOW);
  assert.equal(bucketCount(), 500);

  // A flood of refusals across all keys…
  for (let i = 0; i < 500; i += 1) for (let n = 0; n < 50; n += 1) void consume(ip(i), rules, NOW);
  assert.equal(bucketCount(), 500, "refused requests must not create buckets");

  // …changes nothing about the schedule: the window still resets on time,
  // and the second request of the new window reports the tightened allowance.
  assert.equal(consume(ip(0), rules, NOW + 60_000).allowed, true);
  assert.equal(consume(ip(0), rules, NOW + 60_000).remaining, 118);
});

test("a runaway agent is refused after its exact allowance, not one request later", () => {
  const rules = [rule("agent", 7)];
  let allowed = 0;
  let refused = 0;
  for (let n = 0; n < 200; n += 1) {
    const decision = consume(agent(42), rules, NOW);
    if (decision.allowed) allowed += 1;
    else refused += 1;
  }
  assert.equal(allowed, 7);
  assert.equal(refused, 193);
});

test("the bucket map is bounded by MAX_BUCKETS even under key pressure", () => {
  const rules = [rule("ip", 1)];
  const many = Array.from({ length: MAX_BUCKETS + 500 }, (_, i) => ip(i));
  for (let i = 0; i < many.length; i += 1) {
    consume(many[i], rules, NOW);
    assert.ok(bucketCount() <= MAX_BUCKETS, `over cap after key ${i}: ${bucketCount()}`);
  }
  assert.equal(bucketCount(), MAX_BUCKETS);
});

test("expired windows are dropped before live ones, and the newest survives pressure", () => {
  const rules = [rule("ip", 1, 60_000)];
  const oldKeys = Array.from({ length: MAX_BUCKETS }, (_, i) => ip(i));
  for (let i = 0; i < oldKeys.length; i += 1) consume(oldKeys[i], rules, NOW);
  assert.equal(bucketCount(), MAX_BUCKETS);

  // A new key arrives in the next window…
  const replacement = ip(99_999);
  assert.equal(consume(replacement, rules, NOW + 60_001).allowed, true);
  // …still within the cap because every previous window has expired…
  assert.equal(bucketCount(), MAX_BUCKETS);
  // …and the NEW key's bucket is the one that survives, not an arbitrary one.
  assert.equal(consume(replacement, rules, NOW + 60_001).allowed, false);
  assert.equal(consume(replacement, rules, NOW + 60_001).exceeded, "ip");
});

test("decisions are fully deterministic: the same requests, the same verdicts", () => {
  const run = (): boolean[] =>
    Array.from({ length: 50 }, (_, i) => agent(i)).flatMap((keys) =>
      Array.from({ length: 8 }, () => consume(keys, [rule("agent", 3)], NOW).allowed),
    );

  resetRateLimits();
  const first = run();
  resetRateLimits();
  const second = run();
  assert.deepEqual(first, second);
  assert.equal(first.filter(Boolean).length, 50 * 3);
});

test("peek stays consistent while the same key is hammered", () => {
  const rules = [rule("agent", 20)];
  for (let n = 0; n < 17; n += 1) void consume(agent(7), rules, NOW);
  const view = peek(agent(7), rules, NOW);
  assert.equal(view.agent.used, 17);
  assert.equal(view.agent.limit, 20);
  assert.ok(view.agent.resetsInSeconds > 0 && view.agent.resetsInSeconds <= 60);
  // Peeking does not mutate, so the next consume sees identical state.
  const decision = consume(agent(7), rules, NOW);
  assert.equal(decision.allowed, true);
  assert.equal(decision.remaining, 2);
});

test("a mixed production-shaped load stays inside its envelope", () => {
  // 10k requests across 1,000 wallets and 50 distinct IPs, all beneath the
  // default allowances — a busy, healthy hour, not an attack.
  const rules = [
    rule("ip", 10_000),
    rule("wallet", 10_000),
    rule("agent", 10_000),
    rule("route", 50_000),
  ];
  let refused = 0;
  const started = performance.now();
  for (let i = 0; i < 10_000; i += 1) {
    const keys: RateLimitKeys = {
      ip: `10.20.30.${i % 50}`,
      wallet: `G-WALLET-${String(i % 1_000).padStart(9, "0")}`,
      agentId: `agent-${String(i % 1_000).padStart(5, "0")}`,
      route: "premiumPrice",
    };
    if (!consume(keys, rules, NOW + i).allowed) refused += 1;
  }
  const durationMs = performance.now() - started;
  assert.equal(refused, 0);
  // 1,000 wallets + 1,000 agents + 50 IPs + one route, all live.
  assert.equal(bucketCount(), 1_000 + 1_000 + 50 + 1);
  assert.ok(durationMs < 30_000, `sustained mixed load must stay fast, took ${durationMs.toFixed(0)}ms`);
});