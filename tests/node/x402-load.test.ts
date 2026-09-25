/**
 * Load-level coverage of x402 verification and replay limits.
 *
 * `x402-scheme.test.ts` proves the decision logic; this suite proves the SCALE
 * holds the same way: a busy worker verifying thousands of concurrent proofs
 * must read each payment exactly once, settle every fresh hash exactly once, and
 * refuse every replay of an already-settled hash — and the in-process replay set
 * must stay bounded exactly like the durable ledger it stands in for.
 */

import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";

import { ExactStellarFacilitator, CONSUMED_MAX } from "../../lib/x402/stellar-scheme";
import {
  fakeHorizonBackend,
  landedPayment,
  makeRequirements,
  nextTxHash,
  resetTxHashSequence,
  runX402Load,
  settleFixtures,
  signedProof,
  toPaymentPayload,
} from "./x402-fixtures";

const NOW = 1_800_000_000_000;
const MAX_AGE_MS = 5 * 60 * 1000;

beforeEach(() => settleFixtures.reset());

test("a large concurrent run verifies everything, each against its own payment", async () => {
  const stats = await runX402Load({ count: 1_000, concurrency: 120, now: NOW, maxAgeMs: MAX_AGE_MS });
  assert.equal(stats.verifiedOk, 1_000);
  assert.equal(stats.settledOk, 1_000);
  assert.equal(stats.replaysRefused, 1_000);
  assert.equal(stats.txReads, 1_000);
  assert.equal(stats.opsReads, 1_000);
  assert.equal(stats.consumedAfter, 1_000);
});

test("no collateral reads: each proof touches exactly two Horizon calls", async () => {
  // Two thousand verifications across one hundred workers.
  const stats = await runX402Load({ count: 2_000, concurrency: 100, now: NOW, maxAgeMs: MAX_AGE_MS });
  assert.equal(stats.txReads, 2_000);
  assert.equal(stats.opsReads, 2_000);
});

test("every hash a load run settled buys exactly one response", async () => {
  const stats = await runX402Load({ count: 300, concurrency: 60, now: NOW, maxAgeMs: MAX_AGE_MS });
  const requirements = makeRequirements();
  const backendA = fakeHorizonBackend(
    stats.transactions.map((transaction) =>
      landedPayment({ transaction, createdAtMs: NOW - 1_000 }),
    ),
  );
  const facilitator = new ExactStellarFacilitator(backendA);
  for (const transaction of stats.transactions) {
    const payload = toPaymentPayload(signedProof(transaction, requirements), requirements);
    const replay = await facilitator.settle(payload, requirements);
    assert.equal(replay.success, false);
    assert.equal(replay.errorReason, "already_settled");
  }
});

test("a second load run decides identically, given a reset", async () => {
  // Same count => same deterministic hash stream => same settlement outcomes.
  const a = await runX402Load({ count: 200, concurrency: 25, now: NOW, maxAgeMs: MAX_AGE_MS });
  settleFixtures.reset();
  const b = await runX402Load({ count: 200, concurrency: 25, now: NOW, maxAgeMs: MAX_AGE_MS });
  assert.deepEqual(a.transactions, b.transactions);
  assert.equal(a.verifiedOk, b.verifiedOk);
  assert.equal(a.settledOk, b.settledOk);
  assert.equal(a.replaysRefused, b.replaysRefused);
});

test("the fixture hash stream is a deterministic sequence", () => {
  resetTxHashSequence();
  const first = Array.from({ length: 5 }, nextTxHash);
  resetTxHashSequence();
  assert.deepEqual(Array.from({ length: 5 }, nextTxHash), first);
  // Collision-freedom inside one run matters more than beauty of the bytes.
  assert.equal(new Set(first).size, first.length);
});

test("the in-process replay set stays bounded while the newest hash is still refused", async () => {
  // `consume` denies a replay only while the hash is in the bounded set; beyond
  // the cap, the oldest hashes are forgotten (they are far outside the freshness
  // window) and the newest remain spendable-blocked. Assert both facts.
  settleFixtures.reset();
  const requirements = makeRequirements();
  const hashes = Array.from({ length: CONSUMED_MAX + 200 }, () => nextTxHash());

  for (let i = 0; i < CONSUMED_MAX - 1; i += 1) {
    assert.equal(await settleFixtures.consume(requirements.network, hashes[i]), true);
  }
  assert.ok(settleFixtures.count() <= CONSUMED_MAX);

  // The newest hashes beyond the cap are all consumed and refused on replay.
  const newest = hashes.slice(CONSUMED_MAX - 1);
  for (const transaction of newest) {
    assert.equal(await settleFixtures.consume(requirements.network, transaction), true);
    assert.equal(await settleFixtures.inspect(requirements.network, transaction), true);
  }
  assert.ok(settleFixtures.count() <= CONSUMED_MAX);

  // The oldest evicted hash can be re-consumed (the set forgot it); a still-held
  // hash is refused.
  const evicted = hashes[0];
  const stillHeld = hashes[hashes.length - 1];
  assert.equal(await settleFixtures.inspect(requirements.network, evicted), false);
  assert.equal(await settleFixtures.consume(requirements.network, evicted), true);
  assert.equal(await settleFixtures.consume(requirements.network, stillHeld), false);
  assert.ok(settleFixtures.count() <= CONSUMED_MAX);
});

test("a load run's verifications add no permanent records to the replay set", async () => {
  // Verification is a read; settlement is the only thing that consumes a hash.
  const stats = await runX402Load({ count: 100, concurrency: 10, now: NOW, maxAgeMs: MAX_AGE_MS });
  assert.equal(stats.consumedAfter, 100);
  assert.equal(settleFixtures.count(), 100);
});