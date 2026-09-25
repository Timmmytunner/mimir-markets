import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  EVIDENCE_COMMITMENT_VERSION,
  MAX_EVIDENCE_AGE_MS,
  MAX_EVIDENCE_COMMITMENT_BYTES,
  EvidenceCommitmentError,
  canonicalEvidenceBytes,
  evidenceCommitmentHash,
  evidenceContentHash,
  verifyEvidenceCommitment,
  type EvidenceCommitmentInput,
} from "../../lib/evidence-commitment";

const RS = String.fromCharCode(0x1e);
const US = String.fromCharCode(0x1f);

function baseTally() {
  return { creator: 2, challengers: 1, draw: 0, unresolvable: 0, decisive: 3 };
}

function tally(overrides: Partial<ReturnType<typeof baseTally>> = {}): ReturnType<typeof baseTally> {
  return { ...baseTally(), ...overrides };
}

function reason(err: unknown): string {
  return err instanceof EvidenceCommitmentError ? err.reason : "not-an-evidence-error";
}

function assertRejects(input: EvidenceCommitmentInput, expected: string): void {
  assert.throws(
    () => evidenceCommitmentHash(input),
    (err: unknown) => err instanceof EvidenceCommitmentError && err.reason === expected,
    `expected EvidenceCommitmentError(${expected})`,
  );
}

// ── Positive: deterministic canonical bytes ───────────────────────────────────

test("the digest is SHA-256 over the canonical bytes and is reproducible", () => {
  const input: EvidenceCommitmentInput = {
    evidence: "Bitcoin closed at $101,200 on 2026-05-25.",
    fetcher: "coingecko-api",
    sourceUrl: "https://www.coingecko.com/en/coins/bitcoin",
  };
  const bytes = canonicalEvidenceBytes(input);
  const hash = evidenceCommitmentHash(input);
  // Independent implementation of the digest the module promises.
  assert.equal(hash, createHash("sha256").update(bytes).digest("hex"));
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(hash, evidenceCommitmentHash({ ...input }));
});

test("the canonical layout is a versioned, length-framed header", () => {
  const bytes = canonicalEvidenceBytes({ evidence: "hello", fetcher: "direct", sourceUrl: "" });
  assert.match(
    bytes.toString("utf8"),
    new RegExp(
      `^mimir-evidence-commitment\\nversion:${EVIDENCE_COMMITMENT_VERSION}\\nfetcher:direct\\nsource:\\nbytes:5${RS}hello${RS}council:none$`,
    ),
  );
});

test("evidence bytes are framed exactly once and appear verbatim", () => {
  const evidence = "line one\nline two";
  const bytes = canonicalEvidenceBytes({ evidence, fetcher: "jina" });
  const head = `fetcher:jina\nsource:\nbytes:${Buffer.from(evidence, "utf8").length}${RS}`;
  assert.ok(bytes.toString("utf8").includes(head));
  assert.ok(bytes.toString("utf8").endsWith(`${RS}council:none`));
});

// ── Negative: boundary forgery is impossible ──────────────────────────────────

test("page content cannot forge a council boundary", () => {
  const council = { tally: tally() };
  // The exact string the old concatenation scheme would have produced for a real
  // council settlement…
  const forged = `page${"\n"}[council]${JSON.stringify(council.tally)}`;
  const soloHash = evidenceCommitmentHash({ evidence: forged, fetcher: "direct" });
  const realHash = evidenceCommitmentHash({ evidence: "page", fetcher: "direct", council });
  // …must not equal the digest of an actual council settlement.
  assert.notEqual(soloHash, realHash);
});

test("evidence bodies containing separators stay inside their frame", () => {
  const evidence = `before${RS}council${US}tally:99,99,0,0,2${US}after`;
  const bytes = canonicalEvidenceBytes({ evidence, fetcher: "direct" });
  // The body is length-prefixed, so the injected separators are data, not framing.
  assert.match(bytes.toString("utf8"), /bytes:\d+/);
  assert.equal(
    bytes.toString("utf8").split(`${RS}council:none`).length - 1,
    1,
    "the frame tail occurs exactly once",
  );
});

test("boundary-collision split does not reproduce the same digest", () => {
  // Under a naive concatenation these could be arranged to collide; the explicit
  // byte count makes each split a different byte string.
  const withCouncil = evidenceCommitmentHash({
    evidence: "abcd",
    fetcher: "direct",
    council: { tally: tally() },
  });
  const longerBody = evidenceCommitmentHash({ evidence: "abcd", fetcher: "direct" });
  assert.notEqual(withCouncil, longerBody);
});

// ── Negative: fail closed on invalid input ────────────────────────────────────

test("unpaired surrogates are refused instead of lossily encoded", () => {
  assertRejects({ evidence: `bad\uD800tail`, fetcher: "direct" }, "invalid_encoding");
  assertRejects({ evidence: `bad\uDC00tail`, fetcher: "direct" }, "invalid_encoding");
});

test("empty and whitespace-only evidence is refused", () => {
  assertRejects({ evidence: "", fetcher: "direct" }, "empty_evidence");
  assertRejects({ evidence: "   \n\t ", fetcher: "direct" }, "empty_evidence");
});

test("an unknown fetch route is refused", () => {
  assertRejects(
    { evidence: "x", fetcher: "carrier-pigeon" as never },
    "invalid_fetcher",
  );
});

test("a malformed resolution URL is refused", () => {
  assertRejects({ evidence: "x", fetcher: "direct", sourceUrl: "not-a-url" }, "invalid_source_url");
  assertRejects(
    { evidence: "x", fetcher: "direct", sourceUrl: "https://a.test/\nheader" },
    "invalid_source_url",
  );
});

test("an oversized evidence body is refused", () => {
  assertRejects(
    { evidence: "a".repeat(MAX_EVIDENCE_COMMITMENT_BYTES + 1), fetcher: "direct" },
    "evidence_too_large",
  );
});

test("a stale snapshot is refused", () => {
  const now = 1_000_000_000_000;
  assertRejects(
    { evidence: "x", fetcher: "direct", fetchedAt: now - MAX_EVIDENCE_AGE_MS - 1, now },
    "stale_evidence",
  );
});

test("a corrupt council record is refused", () => {
  assertRejects(
    { evidence: "x", fetcher: "direct", council: { tally: tally({ creator: -1 }) } },
    "invalid_council",
  );
  assertRejects(
    { evidence: "x", fetcher: "direct", council: { tally: tally({ decisive: 1.5 }) } },
    "invalid_council",
  );
  assertRejects(
    {
      evidence: "x",
      fetcher: "direct",
      council: { tally: tally(), qChain: [0.5, 0.9], scores: [0.1] },
    },
    "invalid_council",
  );
  assertRejects(
    { evidence: "x", fetcher: "direct", council: { tally: tally(), referenceQ: 0.9 } },
    "invalid_council",
  );
  assertRejects(
    { evidence: "x", fetcher: "direct", council: { tally: tally(), qChain: [1.4], scores: [0] } },
    "invalid_council",
  );
  assertRejects(
    { evidence: "x", fetcher: "direct", council: { tally: tally(), qChain: [0.5], scores: [101] } },
    "invalid_council",
  );
});

// ── Boundary: exact limits pass ───────────────────────────────────────────────

test("the byte cap and freshness window are inclusive at their boundary", () => {
  const atCap = evidenceCommitmentHash({
    evidence: "a".repeat(MAX_EVIDENCE_COMMITMENT_BYTES),
    fetcher: "direct",
  });
  assert.match(atCap, /^[0-9a-f]{64}$/);

  const now = 1_000_000_000_000;
  const atEdge = evidenceCommitmentHash({
    evidence: "x",
    fetcher: "direct",
    fetchedAt: now - MAX_EVIDENCE_AGE_MS,
    now,
  });
  assert.match(atEdge, /^[0-9a-f]{64}$/);
});

test("a council record with no chain is allowed (majority-tally mode)", () => {
  const hash = evidenceCommitmentHash({ evidence: "x", fetcher: "direct", council: { tally: tally() } });
  assert.match(hash, /^[0-9a-f]{64}$/);
});

// ── Canonicalization: equal inputs, equal bytes ───────────────────────────────

test("tally key insertion order does not change the digest", () => {
  const ordered = { creator: 1, challengers: 2, draw: 0, unresolvable: 0, decisive: 3 };
  const shuffled = { decisive: 3, unresolvable: 0, draw: 0, challengers: 2, creator: 1 };
  assert.equal(
    evidenceCommitmentHash({ evidence: "e", fetcher: "direct", council: { tally: ordered } }),
    evidenceCommitmentHash({ evidence: "e", fetcher: "direct", council: { tally: shuffled } }),
  );
});

test("the fetch route and source URL are part of the commitment", () => {
  const base = evidenceCommitmentHash({ evidence: "e", fetcher: "direct" });
  assert.notEqual(base, evidenceCommitmentHash({ evidence: "e", fetcher: "jina" }));
  assert.notEqual(
    base,
    evidenceCommitmentHash({ evidence: "e", fetcher: "direct", sourceUrl: "https://a.test/x" }),
  );
});

// ── Privacy: only whitelisted fields are committed ────────────────────────────

test("prompts, wallets, payments and analytics never enter the bytes", () => {
  const base: EvidenceCommitmentInput = { evidence: "public page text", fetcher: "direct" };
  const smuggled = {
    ...base,
    prompt: "SECRET-PROMPT-TEXT",
    walletAddress: "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW",
    analyticsId: "user-42",
    payment: { txHash: "ab".repeat(32), priceUnits: "5000" },
  } as unknown as EvidenceCommitmentInput;

  assert.equal(evidenceCommitmentHash(base), evidenceCommitmentHash(smuggled));
  const bytes = canonicalEvidenceBytes(smuggled).toString("utf8");
  assert.ok(!bytes.includes("SECRET-PROMPT-TEXT"));
  assert.ok(!bytes.includes("user-42"));
  assert.ok(!bytes.includes("ab".repeat(32)));
});

test("the council record is aggregate accounting, not identities", () => {
  const bytes = canonicalEvidenceBytes({
    evidence: "e",
    fetcher: "direct",
    council: {
      tally: tally(),
      qChain: [0.5, 0.9],
      referenceQ: 0.9,
      scores: [0, 0.3],
    },
  }).toString("utf8");
  assert.ok(bytes.includes("council"));
  assert.ok(bytes.includes("tally:"));
  assert.ok(bytes.includes("q:0.5000,0.9000"));
  assert.ok(bytes.includes("refQ:0.9000"));
  assert.ok(bytes.includes("scores:0.0000,0.3000"));
  // No wallet-shaped strings.
  assert.ok(!/G[A-Z2-7]{55}/.test(bytes));
});

// ── Verification helpers ──────────────────────────────────────────────────────

test("evidenceContentHash is SHA-256 over the body's UTF-8 bytes", () => {
  assert.equal(
    evidenceContentHash("abc"),
    createHash("sha256").update(Buffer.from("abc", "utf8")).digest("hex"),
  );
});

test("verifyEvidenceCommitment accepts exact digests and rejects everything else", () => {
  const input: EvidenceCommitmentInput = { evidence: "settled", fetcher: "direct" };
  const hash = evidenceCommitmentHash(input);
  assert.equal(verifyEvidenceCommitment(input, hash), true);
  assert.equal(verifyEvidenceCommitment(input, `0x${hash.toUpperCase()}`), true);
  assert.equal(verifyEvidenceCommitment(input, "0".repeat(64)), false);
  assert.equal(verifyEvidenceCommitment({ ...input, fetcher: "jina" }, hash), false);
  // An input that cannot be canonicalised is not a match.
  assert.equal(verifyEvidenceCommitment({ evidence: "", fetcher: "direct" }, hash), false);
  assert.equal(reason(new EvidenceCommitmentError("empty_evidence", "x")), "empty_evidence");
});

// ── Regression: dependency-failure placeholders stay stable ───────────────────

test("deterministic placeholders hash stably across polls", () => {
  const placeholder = "(No resolution URL provided)";
  const first = evidenceCommitmentHash({ evidence: placeholder, fetcher: "none" });
  const second = evidenceCommitmentHash({ evidence: placeholder, fetcher: "none" });
  assert.equal(first, second);
  assert.match(first, /^[0-9a-f]{64}$/);
});
