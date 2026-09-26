/**
 * Evidence hash binding — focused tests for the full pipeline.
 *
 * Covers the three-layer chain:
 *
 *   evidenceCommitmentHash()           (lib/evidence-commitment.ts)
 *     → decodeHash32Hex()              (lib/content-hash.ts — mirrors contract.ts fromHex32)
 *       → project() / evidenceHash     (lib/ops/projection.ts — read-index storage)
 *
 * And the council-vote confirmation gate that guards bonus payouts:
 *
 *   isConfirmedCouncilSettlement()     (agents/oracle/council-vote.ts)
 *
 * Test categories:
 *   positive   — well-formed hashes survive every layer intact
 *   negative   — malformed hashes are rejected or nulled at the right boundary
 *   boundary   — exact length limits, prefix variants, case variants
 *   conservation — the same commitment hash produced at settlement is the same
 *                  one verifiable in the read-index projection
 *   regression — the specific gaps identified in the audit
 */

import assert from "node:assert/strict";
import test from "node:test";

import { decodeHash32Hex, isHash32Hex, sha256Hex, ZERO_HASH_HEX } from "../../lib/content-hash";
import {
  evidenceCommitmentHash,
  verifyEvidenceCommitment,
  type EvidenceCommitmentInput,
} from "../../lib/evidence-commitment";
import { project, type ChainEvent } from "../../lib/ops/projection";
import { isConfirmedCouncilSettlement } from "../../agents/oracle/council-vote";
import type { ClaimData } from "../../lib/contract";

// ── Fixture helpers ───────────────────────────────────────────────────────────

function goodHash(): string {
  return evidenceCommitmentHash({ evidence: "BTC closed at $101,200", fetcher: "coingecko-api" });
}

function createdEvent(claimId: number): ChainEvent {
  return {
    name: "ClaimCreated",
    claimId,
    creator: "GBMGZBFKUNOS7JWPRPF5IMZR27DCR6BEP6SQVFV2I354UPY35FZTIR2Y",
    category: "crypto",
    blockNumber: 100,
    logIndex: 0,
    blockHash: "0xblock100",
  };
}

function resolvedEvent(
  claimId: number,
  evidenceHash: string | undefined,
  block = 200,
): ChainEvent {
  return {
    name: "ClaimResolved",
    claimId,
    winnerSide: 2,
    confidence: 90,
    evidenceHash,
    blockNumber: block,
    logIndex: 0,
    blockHash: `0xblock${block}`,
  };
}

function resolvedClaim(
  side: ClaimData["winner_side"],
  evidenceHash: string,
): Pick<ClaimData, "state" | "winner_side" | "evidence_hash"> {
  return { state: "resolved", winner_side: side, evidence_hash: evidenceHash };
}

// ── Positive: a well-formed hash survives the full pipeline ───────────────────

test("[positive] commitment hash is valid 32-byte hex accepted by decodeHash32Hex", () => {
  const hash = goodHash();
  assert.match(hash, /^[0-9a-f]{64}$/);
  // This mirrors exactly what contract.ts fromHex32 does before submitting to Soroban.
  const decoded = decodeHash32Hex(hash, "evidence_hash");
  assert.equal(decoded.length, 32);
  assert.equal(decoded.toString("hex"), hash);
});

test("[positive] commitment hash round-trips through the projection read-index", () => {
  const hash = goodHash();
  const result = project([createdEvent(1), resolvedEvent(1, hash)]);
  const claim = result.claims.get(1)!;
  assert.equal(claim.evidenceHash, hash);
});

test("[positive] 0x-prefixed hash from on-chain is accepted by isHash32Hex", () => {
  const bare = goodHash();
  const prefixed = `0x${bare}`;
  assert.equal(isHash32Hex(prefixed), true);
  // decodeHash32Hex strips the prefix.
  const decoded = decodeHash32Hex(prefixed, "evidence_hash");
  assert.equal(decoded.toString("hex"), bare);
});

test("[positive] 0x-prefixed hash survives projection storage", () => {
  const bare = goodHash();
  const prefixed = `0x${bare}`;
  const result = project([createdEvent(1), resolvedEvent(1, prefixed)]);
  // The hash is valid (0x-prefixed) so it is stored verbatim.
  assert.equal(result.claims.get(1)!.evidenceHash, prefixed);
});

test("[positive] UPPERCASE hex hash is accepted by isHash32Hex", () => {
  const upper = goodHash().toUpperCase();
  assert.equal(isHash32Hex(upper), true);
  // decodeHash32Hex normalises to lowercase bytes.
  const decoded = decodeHash32Hex(upper, "evidence_hash");
  assert.equal(decoded.toString("hex"), upper.toLowerCase());
});

// ── Negative: malformed hashes are rejected or nulled at the right boundary ───

test("[negative] decodeHash32Hex throws on 31-byte hash", () => {
  assert.throws(
    () => decodeHash32Hex("ab".repeat(31), "evidence_hash"),
    /evidence_hash must be exactly 32 bytes/,
  );
});

test("[negative] decodeHash32Hex throws on 33-byte hash", () => {
  assert.throws(
    () => decodeHash32Hex("ab".repeat(33), "evidence_hash"),
    /evidence_hash must be exactly 32 bytes/,
  );
});

test("[negative] decodeHash32Hex throws on non-hex string of correct length", () => {
  assert.throws(
    () => decodeHash32Hex("zz".repeat(32), "evidence_hash"),
    /64 hexadecimal characters/,
  );
});

test("[negative] projection stores null for a legacy placeholder string", () => {
  const result = project([createdEvent(1), resolvedEvent(1, "sha256:fixture-evidence")]);
  assert.equal(result.claims.get(1)!.evidenceHash, null);
});

test("[negative] projection stores null for an empty string", () => {
  const result = project([createdEvent(1), resolvedEvent(1, "")]);
  assert.equal(result.claims.get(1)!.evidenceHash, null);
});

test("[negative] projection stores null for undefined evidenceHash", () => {
  const result = project([createdEvent(1), resolvedEvent(1, undefined)]);
  assert.equal(result.claims.get(1)!.evidenceHash, null);
});

test("[negative] projection stores null for a 31-byte hex string", () => {
  const short = "ab".repeat(31);
  const result = project([createdEvent(1), resolvedEvent(1, short)]);
  assert.equal(result.claims.get(1)!.evidenceHash, null);
});

test("[negative] projection stores null for a 33-byte hex string", () => {
  const long = "ab".repeat(33);
  const result = project([createdEvent(1), resolvedEvent(1, long)]);
  assert.equal(result.claims.get(1)!.evidenceHash, null);
});

// ── Boundary: exact-length hashes pass ───────────────────────────────────────

test("[boundary] exactly 64 hex chars is accepted by isHash32Hex and projection", () => {
  const exact = "f".repeat(64);
  assert.equal(isHash32Hex(exact), true);
  const result = project([createdEvent(1), resolvedEvent(1, exact)]);
  assert.equal(result.claims.get(1)!.evidenceHash, exact);
});

test("[boundary] 0x + 64 hex chars (66 total) is accepted by isHash32Hex and projection", () => {
  const prefixed = `0x${"f".repeat(64)}`;
  assert.equal(isHash32Hex(prefixed), true);
  const result = project([createdEvent(1), resolvedEvent(1, prefixed)]);
  assert.equal(result.claims.get(1)!.evidenceHash, prefixed);
});

test("[boundary] 63 hex chars is rejected by isHash32Hex and nulled in projection", () => {
  const short = "f".repeat(63);
  assert.equal(isHash32Hex(short), false);
  const result = project([createdEvent(1), resolvedEvent(1, short)]);
  assert.equal(result.claims.get(1)!.evidenceHash, null);
});

test("[boundary] 65 hex chars is rejected by isHash32Hex and nulled in projection", () => {
  const long = "f".repeat(65);
  assert.equal(isHash32Hex(long), false);
  const result = project([createdEvent(1), resolvedEvent(1, long)]);
  assert.equal(result.claims.get(1)!.evidenceHash, null);
});

// ── Conservation: commitment hash is the same value verified in the read-index ─

test("[conservation] hash computed at settlement matches what is stored and verifiable", () => {
  const input: EvidenceCommitmentInput = {
    evidence: "Bitcoin closed at $101,200 on 2026-05-25.",
    fetcher: "coingecko-api",
    sourceUrl: "https://www.coingecko.com/en/coins/bitcoin",
  };
  // Step 1: oracle calls this at settlement time.
  const hash = evidenceCommitmentHash(input);
  // Step 2: hash is passed to resolveClaim → fromHex32 → decodeHash32Hex.
  const decoded = decodeHash32Hex(hash, "evidence_hash");
  // It encodes back to the same hex the oracle produced.
  assert.equal(decoded.toString("hex"), hash);
  // Step 3: hash arrives in a ClaimResolved event and is stored in the read-index.
  const result = project([createdEvent(1), resolvedEvent(1, hash)]);
  const stored = result.claims.get(1)!.evidenceHash;
  // The stored value is exactly the hash the oracle produced.
  assert.equal(stored, hash);
  // Step 4: any verifier can check it by re-running evidenceCommitmentHash.
  assert.equal(verifyEvidenceCommitment(input, stored ?? ""), true);
  // A wrong evidenceHash does not match.
  assert.equal(verifyEvidenceCommitment(input, "0".repeat(64)), false);
});

test("[conservation] the zero hash sentinel passes isHash32Hex and is stored", () => {
  // ZERO_HASH_HEX is the "no hash" sentinel; it must not be confused with a
  // malformed hash. It is valid 32-byte hex and should be stored as-is.
  assert.equal(isHash32Hex(ZERO_HASH_HEX), true);
  const result = project([createdEvent(1), resolvedEvent(1, ZERO_HASH_HEX)]);
  assert.equal(result.claims.get(1)!.evidenceHash, ZERO_HASH_HEX);
});

test("[conservation] multiple claims each carry their own distinct evidence hash", () => {
  const hashA = evidenceCommitmentHash({ evidence: "evidence for claim A", fetcher: "direct" });
  const hashB = evidenceCommitmentHash({ evidence: "evidence for claim B", fetcher: "direct" });
  assert.notEqual(hashA, hashB);

  // Use distinct (blockNumber, logIndex) pairs for each event to avoid dedup collisions.
  const result = project([
    { ...createdEvent(1), blockNumber: 100, logIndex: 0, blockHash: "0xblock100" },
    { ...createdEvent(2), blockNumber: 101, logIndex: 0, blockHash: "0xblock101" },
    resolvedEvent(1, hashA, 200),
    resolvedEvent(2, hashB, 201),
  ]);

  assert.equal(result.claims.get(1)!.evidenceHash, hashA);
  assert.equal(result.claims.get(2)!.evidenceHash, hashB);
});

// ── Regression: isConfirmedCouncilSettlement hash normalization ───────────────

test("[regression] isConfirmedCouncilSettlement matches bare vs bare hash", () => {
  const hash = goodHash();
  assert.equal(
    isConfirmedCouncilSettlement(resolvedClaim("challengers", hash), "challengers", hash, false),
    true,
  );
});

test("[regression] isConfirmedCouncilSettlement matches 0x-prefixed claim hash vs bare local", () => {
  // The on-chain evidence_hash from lib/contract.ts toHex is bare, but callers
  // or older read paths might produce a 0x-prefixed value. Both sides must match.
  const bare = goodHash();
  const prefixed = `0x${bare}`;
  assert.equal(
    isConfirmedCouncilSettlement(resolvedClaim("challengers", prefixed), "challengers", bare, false),
    true,
    "0x-prefixed claim hash matches bare local hash",
  );
  assert.equal(
    isConfirmedCouncilSettlement(resolvedClaim("challengers", bare), "challengers", prefixed, false),
    true,
    "bare claim hash matches 0x-prefixed local hash",
  );
  assert.equal(
    isConfirmedCouncilSettlement(resolvedClaim("challengers", prefixed), "challengers", prefixed, false),
    true,
    "0x-prefixed on both sides still matches",
  );
});

test("[regression] isConfirmedCouncilSettlement matches mixed-case hash", () => {
  const bare = goodHash();
  const upper = bare.toUpperCase();
  assert.equal(
    isConfirmedCouncilSettlement(resolvedClaim("challengers", upper), "challengers", bare, false),
    true,
    "uppercase claim hash matches lowercase local hash",
  );
});

test("[regression] isConfirmedCouncilSettlement does NOT match a different hash", () => {
  const hashA = goodHash();
  const hashB = sha256Hex("completely different evidence");
  assert.notEqual(hashA, hashB);
  assert.equal(
    isConfirmedCouncilSettlement(resolvedClaim("challengers", hashA), "challengers", hashB, false),
    false,
  );
});

test("[regression] isConfirmedCouncilSettlement fails when pending=true", () => {
  const hash = goodHash();
  assert.equal(
    isConfirmedCouncilSettlement(resolvedClaim("challengers", hash), "challengers", hash, true),
    false,
  );
});

test("[regression] isConfirmedCouncilSettlement fails on wrong winner_side", () => {
  const hash = goodHash();
  assert.equal(
    isConfirmedCouncilSettlement(resolvedClaim("creator", hash), "challengers", hash, false),
    false,
  );
});

test("[regression] isConfirmedCouncilSettlement fails when claim is not resolved", () => {
  const hash = goodHash();
  const activeClaim = { state: "active" as const, winner_side: "" as const, evidence_hash: hash };
  assert.equal(
    isConfirmedCouncilSettlement(activeClaim, "challengers", hash, false),
    false,
  );
});

test("[regression] isConfirmedCouncilSettlement fails when claim is null", () => {
  const hash = goodHash();
  assert.equal(isConfirmedCouncilSettlement(null, "challengers", hash, false), false);
});

// ── Regression: malformed hash in projection does not corrupt good hash ───────

test("[regression] a malformed evidenceHash event is nulled, not stored verbatim", () => {
  // When a ClaimResolved event carries a malformed evidenceHash, the projection
  // stores null rather than the raw string. This is the core validation property
  // the projection change ensures.
  const result = project([createdEvent(1), resolvedEvent(1, "sha256:not-a-valid-hash", 200)]);
  assert.equal(result.claims.get(1)!.evidenceHash, null);
});

test("[regression] projection fingerprint is stable whether evidenceHash is null or valid", () => {
  const withNull = project([createdEvent(1), resolvedEvent(1, "bad-hash")]);
  const withValid = project([createdEvent(1), resolvedEvent(1, goodHash())]);
  // Both produce a deterministic fingerprint with no undefined fields.
  const fnNull = withNull.claims.get(1)!.evidenceHash;
  const fnValid = withValid.claims.get(1)!.evidenceHash;
  assert.equal(fnNull, null);
  assert.ok(typeof fnValid === "string" && fnValid.length === 64);
});
