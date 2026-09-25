import assert from "node:assert/strict";
import test from "node:test";

import {
  compareEvents,
  eventKey,
  project,
  projectionFingerprint,
  resumeFromBlock,
  type ChainEvent,
} from "../../lib/ops/projection";

const CREATOR = "0x000000000000000000000000000000000000000a";
const ALICE = "0x000000000000000000000000000000000000000b";
const BOB = "0x000000000000000000000000000000000000000c";

function created(claimId: number, block: number, logIndex = 0): ChainEvent {
  return {
    name: "ClaimCreated",
    claimId,
    creator: CREATOR,
    category: "crypto",
    blockNumber: block,
    logIndex,
    blockHash: `0xblock${block}`,
  };
}

function challenged(
  claimId: number,
  challenger: string,
  stake: bigint,
  block: number,
  logIndex = 0,
): ChainEvent {
  return {
    name: "ClaimChallenged",
    claimId,
    challenger,
    stakeUnits: stake,
    blockNumber: block,
    logIndex,
    blockHash: `0xblock${block}`,
  };
}

function resolved(claimId: number, block: number, logIndex = 0): ChainEvent {
  return {
    name: "ClaimResolved",
    claimId,
    winnerSide: 2,
    confidence: 88,
    evidenceHash: "0x" + "ab".repeat(32),
    blockNumber: block,
    logIndex,
    blockHash: `0xblock${block}`,
  };
}

/** A small history exercising every event type. */
function history(): ChainEvent[] {
  return [
    created(1, 100),
    challenged(1, ALICE, 5_000_000n, 101),
    challenged(1, BOB, 3_000_000n, 102),
    resolved(1, 200),
    created(2, 110),
    { ...created(2, 110), name: "ClaimCancelled", claimId: 2, blockNumber: 120, logIndex: 0 },
  ];
}

// ── The rebuild guarantee ─────────────────────────────────────────────────────

test("replaying the same events produces byte-identical rows", () => {
  // This IS the "delete Postgres and rebuild from chain" guarantee.
  const first = project(history());
  const second = project(history());
  assert.equal(projectionFingerprint(first), projectionFingerprint(second));
});

test("arrival order does not change the result", () => {
  // Events come back from concurrent getLogs chunks, so folding in arrival order
  // would make the index depend on RPC scheduling.
  const forward = project(history());
  const shuffled = project([...history()].reverse());
  assert.equal(projectionFingerprint(forward), projectionFingerprint(shuffled));
});

test("challenger order is normalised, not arrival-dependent", () => {
  const abOrder = project([created(1, 100), challenged(1, ALICE, 1n, 101), challenged(1, BOB, 2n, 102)]);
  const baOrder = project([created(1, 100), challenged(1, BOB, 2n, 102), challenged(1, ALICE, 1n, 101)]);
  assert.deepEqual(
    abOrder.claims.get(1)!.challengers.map((c) => c.address),
    baOrder.claims.get(1)!.challengers.map((c) => c.address),
  );
});

test("a partial rebuild extended to the full history matches a full rebuild", () => {
  // A resync that resumes mid-history must converge on the same rows.
  const full = project(history());
  const firstHalf = history().slice(0, 3);
  const combined = project([...firstHalf, ...history()]);
  assert.equal(projectionFingerprint(combined), projectionFingerprint(full));
});

// ── Idempotency ───────────────────────────────────────────────────────────────

test("replaying an event does not double a stake", () => {
  const events = [created(1, 100), challenged(1, ALICE, 5_000_000n, 101)];
  const doubled = project([...events, ...events]);
  const claim = doubled.claims.get(1)!;
  assert.equal(claim.totalChallengerStakeUnits, 5_000_000n);
  assert.equal(claim.challengers.length, 1);
  assert.equal(doubled.duplicatesSkipped, 2);
});

test("an overlapping resync range is normal and reports its duplicates", () => {
  const events = history();
  const overlapping = project([...events, ...events.slice(1, 4)]);
  assert.ok(overlapping.duplicatesSkipped > 0);
  assert.equal(projectionFingerprint(overlapping), projectionFingerprint(project(events)));
});

test("two different logs in the same block are both applied", () => {
  // Dedup is by (block, logIndex), not by block.
  const result = project([
    created(1, 100, 0),
    challenged(1, ALICE, 1_000n, 100, 1),
    challenged(1, BOB, 2_000n, 100, 2),
  ]);
  assert.equal(result.claims.get(1)!.challengers.length, 2);
  assert.equal(result.duplicatesSkipped, 0);
});

test("the event key distinguishes logs within a block", () => {
  assert.notEqual(eventKey({ blockNumber: 1, logIndex: 0 }), eventKey({ blockNumber: 1, logIndex: 1 }));
  assert.notEqual(eventKey({ blockNumber: 1, logIndex: 0 }), eventKey({ blockNumber: 2, logIndex: 0 }));
});

test("ordering is by block then log index", () => {
  assert.ok(compareEvents({ blockNumber: 1, logIndex: 5 }, { blockNumber: 2, logIndex: 0 }) < 0);
  assert.ok(compareEvents({ blockNumber: 2, logIndex: 0 }, { blockNumber: 2, logIndex: 1 }) < 0);
  assert.equal(compareEvents({ blockNumber: 2, logIndex: 1 }, { blockNumber: 2, logIndex: 1 }), 0);
});

// ── Reorg safety ──────────────────────────────────────────────────────────────

test("a reorged-out challenge leaves no stake behind", () => {
  // Without this the index would hold a stake the contract does not, and the pool
  // totals would silently disagree forever.
  const events = [
    created(1, 100),
    challenged(1, ALICE, 5_000_000n, 101),
    challenged(1, BOB, 3_000_000n, 102),
  ];
  const clean = project(events, { reorgedOut: new Set(["0xblock102"]) });
  const claim = clean.claims.get(1)!;
  assert.equal(claim.challengers.length, 1);
  assert.equal(claim.totalChallengerStakeUnits, 5_000_000n);
});

test("a reorg that replaces a log converges on the replacement", () => {
  const orphaned = challenged(1, BOB, 3_000_000n, 102);
  const replacement: ChainEvent = {
    ...challenged(1, BOB, 7_000_000n, 103),
    blockHash: "0xblock103",
  };
  const result = project([created(1, 100), orphaned, replacement], {
    reorgedOut: new Set(["0xblock102"]),
  });
  const claim = result.claims.get(1)!;
  assert.equal(claim.totalChallengerStakeUnits, 7_000_000n);
});

test("dropping a reorged creation drops its dependent events too", () => {
  const result = project([created(1, 100), challenged(1, ALICE, 1_000n, 101)], {
    reorgedOut: new Set(["0xblock100"]),
  });
  assert.equal(result.claims.size, 0);
  // The orphan is counted, so a gap is visible rather than silent.
  assert.equal(result.orphanEvents, 1);
});

// ── State transitions ─────────────────────────────────────────────────────────

test("a claim opens, activates on a challenge, then resolves", () => {
  assert.equal(project([created(1, 100)]).claims.get(1)!.state, "open");
  assert.equal(
    project([created(1, 100), challenged(1, ALICE, 1n, 101)]).claims.get(1)!.state,
    "active",
  );
  const settled = project([created(1, 100), challenged(1, ALICE, 1n, 101), resolved(1, 200)]);
  assert.equal(settled.claims.get(1)!.state, "resolved");
  assert.equal(settled.claims.get(1)!.isFinal, true);
});

test("a resolved claim cannot be reactivated by a late challenge log", () => {
  // A late-arriving log from an earlier block must not un-settle a market.
  const result = project([
    created(1, 100),
    resolved(1, 200),
    challenged(1, BOB, 1_000n, 201),
  ]);
  assert.equal(result.claims.get(1)!.state, "resolved");
});

test("a cancelled claim is final", () => {
  const result = project([
    created(1, 100),
    { ...created(1, 100), name: "ClaimCancelled", blockNumber: 105, logIndex: 0 },
  ]);
  assert.equal(result.claims.get(1)!.state, "cancelled");
  assert.equal(result.claims.get(1)!.isFinal, true);
});

test("resolution detail is projected", () => {
  const claim = project([created(1, 100), resolved(1, 200)]).claims.get(1)!;
  assert.equal(claim.winnerSide, 2);
  assert.equal(claim.confidence, 88);
  assert.match(claim.evidenceHash ?? "", /^0xabab/);
});

test("one address cannot hold two positions on a claim", () => {
  // The contract prevents it, so a repeat is corruption, not a second position.
  const result = project([
    created(1, 100),
    challenged(1, ALICE, 5_000n, 101),
    challenged(1, ALICE, 9_000n, 102),
  ]);
  const claim = result.claims.get(1)!;
  assert.equal(claim.challengers.length, 1);
  assert.equal(claim.totalChallengerStakeUnits, 5_000n);
});

test("addresses are preserved because Stellar strkeys are case-sensitive", () => {
  const result = project([
    created(1, 100),
    challenged(1, ALICE.toUpperCase(), 5_000n, 101),
    challenged(1, ALICE, 9_000n, 102),
  ]);
  assert.equal(result.claims.get(1)!.challengers.length, 2);
  assert.deepEqual(
    new Set(result.claims.get(1)!.challengers.map((entry) => entry.address)),
    new Set([ALICE, ALICE.toUpperCase()]),
  );
});

// ── Gaps ──────────────────────────────────────────────────────────────────────

test("an event for an unseen claim is counted, not silently dropped", () => {
  const result = project([challenged(7, ALICE, 1_000n, 101)]);
  assert.equal(result.claims.size, 0);
  assert.equal(result.orphanEvents, 1);
});

test("a clean history reports no orphans", () => {
  assert.equal(project(history()).orphanEvents, 0);
});

// ── Sync cursor ───────────────────────────────────────────────────────────────

test("the head block is the newest event applied", () => {
  assert.equal(project(history()).headBlock, 200);
});

test("a resync resumes one block behind the head, never at head+1", () => {
  // The last block may have been partially scanned when a chunked fetch was cut
  // short; re-folding a block is free because the fold is idempotent, whereas
  // resuming past it could skip a log forever.
  const result = project(history());
  assert.equal(resumeFromBlock(result, 50), 199);
});

test("an empty history resumes from the deploy block", () => {
  assert.equal(resumeFromBlock(project([]), 12_345), 12_345);
});

test("the resume point never precedes the deploy block", () => {
  const result = project([created(1, 5)]);
  assert.equal(resumeFromBlock(result, 100), 100);
});

test("an empty history projects to nothing rather than failing", () => {
  const result = project([]);
  assert.equal(result.claims.size, 0);
  assert.equal(result.headBlock, 0);
  assert.equal(projectionFingerprint(result), "");
});
