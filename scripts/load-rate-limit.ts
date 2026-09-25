/**
 * Reproducible load test for the API rate limiter — no HTTP, no database, no
 * randomness. It drives the exact `consume()` the request path uses, across the
 * same four dimensions, and asserts the guard's envelope holds while busy: exact
 * limits, refusals that never extend themselves, an unbounded-key memory bound,
 * and a throughput number you can compare between releases.
 *
 *   npm run load:rate-limit
 *   npm run load:rate-limit -- --requests 50000 --keys 5000
 *
 * Exits non-zero if any invariant breaks.
 */

import {
  MAX_BUCKETS,
  bucketCount,
  consume,
  resetRateLimits,
  type RateLimitKeys,
  type LimitRule,
} from "../lib/api/rate-limit";

function arg(name: string, fallback: number): number {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? Number(process.argv[index + 1] ?? NaN) : NaN;
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

const REQUESTS = arg("--requests", 25_000);
const KEYS = arg("--keys", 1_000);
const AGENT_LIMIT = arg("--agent-limit", 120);

let failures = 0;

function check(label: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

// Deterministic wall-clock: the verdicts must be reproducible byte-for-byte.
const NOW = 1_800_000_000_000;

const rules: LimitRule[] = [
  { dimension: "ip", limit: 2_000, windowMs: 60_000 },
  { dimension: "wallet", limit: 2_000, windowMs: 60_000 },
  { dimension: "agent", limit: AGENT_LIMIT, windowMs: 60_000 },
  // The whole burst lands in one route window; the limit only needs to be a
  // ceiling that healthy traffic stays under, not a per-key throttle.
  { dimension: "route", limit: 1_000_000, windowMs: 60_000 },
];

function keysFor(i: number): RateLimitKeys {
  const slot = i % KEYS;
  return {
    ip: `10.${(slot >> 8) & 0xff}.${slot & 0xff}.1`,
    wallet: `G-FIXTURE-${String(slot).padStart(9, "0")}`,
    agentId: `agent-${String(slot).padStart(5, "0")}`,
    route: "premiumPrice",
  };
}

function main(): void {
  resetRateLimits();
  console.log(`API rate-limit load — ${REQUESTS} requests over ${KEYS} keys, agent limit ${AGENT_LIMIT}/min`);
  console.log("");

  // Phase 1: healthy, distributed traffic. Everything must be allowed and the
  // bucket map must hold exactly the live windows — no keys invented by refusal.
  let refused = 0;
  const started = performance.now();
  for (let i = 0; i < REQUESTS; i += 1) {
    if (!consume(keysFor(i), rules, NOW + (i % 60_000)).allowed) refused += 1;
  }
  const durationMs = performance.now() - started;
  check("healthy traffic is never refused", refused === 0, `${refused} refused of ${REQUESTS}`);

  const expectedBuckets =
    KEYS /* wallets */ +
    KEYS /* agents */ +
    KEYS /* ips: i % KEYS hits KEYS distinct /8-suffix values */ +
    1; /* route */
  check("bucket map holds exactly the live windows", bucketCount() === expectedBuckets, `${bucketCount()}`);
  check("bucket map is within MAX_BUCKETS", bucketCount() <= MAX_BUCKETS, `${bucketCount()}/${MAX_BUCKETS}`);

  console.log("");
  console.log(`  requests/s : ${(REQUESTS / (durationMs / 1000)).toFixed(0).padStart(9)}   buckets: ${bucketCount().toString().padStart(9)}`);
  console.log(`  duration   : ${durationMs.toFixed(0).padStart(11)} ms   (mixed 4-dimension traffic)`);
  console.log("");

  // Phase 2: a runaway agent. It must be refused on the exact (limit+1)th
  // request and the refusals must not push its window forward.
  const agentRules: LimitRule[] = [{ dimension: "agent", limit: AGENT_LIMIT, windowMs: 60_000 }];
  let allowed = 0;
  for (let n = 0; n < AGENT_LIMIT + 500; n += 1) {
    if (consume({ agentId: "runaway" }, agentRules, NOW).allowed) allowed += 1;
  }
  check("a runaway agent stops after its exact allowance", allowed === AGENT_LIMIT, `${allowed} of ${AGENT_LIMIT}`);

  check(
    "refusals do not postpone the reset",
    consume({ agentId: "runaway" }, agentRules, NOW + 60_001).allowed,
  );

  // Phase 3: unbounded-key pressure stays inside MAX_BUCKETS.
  const pressureRules: LimitRule[] = [{ dimension: "ip", limit: 1, windowMs: 60_000 }];
  let atCap = 0;
  for (let i = 0; i < MAX_BUCKETS + 500; i += 1) {
    consume({ ip: `p.${i}` }, pressureRules, NOW);
    atCap = Math.max(atCap, bucketCount());
  }
  check(
    "a city-full of distinct IPs cannot overflow the map",
    atCap <= MAX_BUCKETS,
    `peak ${atCap}/${MAX_BUCKETS}`,
  );

  console.log("");
  if (failures > 0) {
    console.error(`✗ ${failures} invariant(s) failed; the rate-limit envelope is broken.`);
    process.exitCode = 1;
  } else {
    console.log("✓ envelope holds — limits exact, refusals inert, memory bounded.");
  }
}

main();