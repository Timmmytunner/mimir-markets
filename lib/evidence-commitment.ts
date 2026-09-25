/**
 * Canonical evidence commitment — the bytes the oracle hashes before settlement.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 *
 * `evidence_hash` is the one piece of the oracle's off-chain work that lands on
 * chain. It is supposed to be a commitment: anyone can re-fetch the resolution
 * URL, reproduce the bytes, and check the digest the contract stored. The EVM
 * code committed a plain `sha256(utf8(text + "\\n[council]" + JSON.stringify(…)))`.
 * That is not a commitment to anything in particular, for three separate reasons:
 *
 *  1. **Boundary forgery.** `text` is attacker-chosen: it is whatever the
 *     resolution page returned. Concatenating it with a trusted `[council]` marker
 *     and JSON meant a page could contain a line that looks like council metadata.
 *     `sha256(a + b)` does not say where `a` ends, so two different settlements
 *     can produce the same digest.
 *  2. **Non-canonical JSON.** `JSON.stringify` follows key insertion order, so two
 *     equal votes objects can serialise differently depending on how they were
 *     built, and a digest that two encodings disagree on commits to neither.
 *  3. **Ill-formed strings.** A lone UTF-16 surrogate is not valid Unicode; Node
 *     silently replaces it with U+FFFD during UTF-8 encoding. Two sources that
 *     differ only in broken code points hash identically, and the digest no longer
 *     describes the bytes the model read.
 *
 * This module produces **canonical evidence bytes** with an explicit, versioned,
 * length-framed layout, validates the inputs that reach it, and hashes them with
 * SHA-256 — `env.crypto().sha256()`'s client-side twin, so a Soroban contract
 * could recompute it (there is no keccak in the host interface).
 *
 * ── What is, and is not, committed (privacy) ─────────────────────────────────
 *
 * The commitment is a whitelist, not a serialization of whatever the caller
 * happens to hold. Only these fields can enter the bytes:
 *
 *   - the fetched evidence text (public by definition — it is the resolution URL)
 *   - the fetch route (which trust tier produced it)
 *   - the resolution URL
 *   - the council tally + self-resolving q-chain/scores (public persona work)
 *
 * Explicitly **excluded**, and unrepresentable in the input type:
 *
 *   - LLM prompts / raw model reasoning (analytics already redacts these)
 *   - wallet or payout addresses (they belong on chain as recipients, not here)
 *   - x402 payment transaction hashes and prices
 *   - analytics/user identifiers
 *   - wall-clock fetch timestamps (validated for staleness, never hashed — a
 *     timestamp in the digest would make it unreproducible by a verifier)
 *
 * ── Failure behavior ────────────────────────────────────────────────────────
 *
 * The boundary fails closed. {@link evidenceCommitmentHash} throws
 * {@link EvidenceCommitmentError} rather than returning a hash for anything it
 * cannot canonicalise, so a malformed snapshot never reaches `resolve_claim`:
 *
 *   - **invalid** (bad type, lone surrogate, empty text, bad fetcher/URL/council)
 *     → throws; the poll loop retries next round, no on-chain write.
 *   - **stale** (`fetchedAt` older than {@link MAX_EVIDENCE_AGE_MS}) → throws;
 *     a cached snapshot is never committed as if it were just read.
 *   - **dependency failure** (no URL / fetch failed) → callers pass the same
 *     deterministic placeholder text they always did; the digest is stable across
 *     polls so a refund verdict can be settled repeatedly without churn.
 *   - **duplicated** input is content-addressed: identical canonical bytes yield
 *     an identical digest, which is intended. Duplicate council ballots are
 *     rejected upstream (`agents/oracle/council-vote.ts`); a duplicated/corrupt
 *     council record here is `invalid_council`.
 *   - **cancelled** claims are never settled by the oracle (`gatherCouncilVerdict`
 *     returns null before a ballot is bought); this module does not hash state it
 *     is not asked to hash.
 */

import { sha256Bytes } from "./content-hash";
import type { EvidenceFetcherKind } from "./server/evidence-fetcher";

/** Bumped whenever the byte layout below changes. Never reused. */
export const EVIDENCE_COMMITMENT_VERSION = 1;

/** Hard cap on one committed evidence body (matches the fetcher's order of magnitude). */
export const MAX_EVIDENCE_COMMITMENT_BYTES = 64 * 1024;

/**
 * A snapshot older than this is refused at the settlement boundary. Generous on
 * purpose: the oracle hashes seconds after fetching, so this only ever fires when
 * a caller accidentally commits a cached snapshot.
 */
export const MAX_EVIDENCE_AGE_MS = 15 * 60_000;

/** A fetch route is either a real fetcher kind or the no-fetch placeholder. */
export type CommittedFetcherKind = EvidenceFetcherKind | "none";

const FETCHER_KINDS: readonly CommittedFetcherKind[] = [
  "coingecko-api",
  "direct",
  "jina",
  "bot-paid",
  "none",
];

/** Council tally as the contract's `WinnerSide` sees it, plus decisive count. */
export interface CouncilTally {
  creator: number;
  challengers: number;
  draw: number;
  unresolvable: number;
  decisive: number;
}

/**
 * The council work that is safe and useful to commit alongside the evidence.
 * No slugs in the tally and no addresses anywhere: the record is aggregate
 * accounting, and the persona identities already live in the reasoning feed.
 */
export interface CouncilCommitment {
  tally: CouncilTally;
  /** Sequential q_t = P(challengers win) reports, self-resolving mode only. */
  qChain?: readonly number[];
  /** Terminal (reference) q_T the chain was scored against. */
  referenceQ?: number;
  /** Per-report cross-entropy scores, aligned with `qChain`. */
  scores?: readonly number[];
}

export interface EvidenceCommitmentInput {
  /** Evidence text exactly as the model read it. Untrusted, but public. */
  evidence: string;
  /** Which path produced the snapshot. */
  fetcher: CommittedFetcherKind;
  /** Resolution URL the text came from. Omitted for no-URL placeholders. */
  sourceUrl?: string | null;
  /** Epoch ms the fetch completed, when known. Validated for staleness, not hashed. */
  fetchedAt?: number | null;
  /** Current time for the staleness check. Defaults to `Date.now()` when `fetchedAt` is set. */
  now?: number;
  /** Optional council tally to commit with the evidence. */
  council?: CouncilCommitment | null;
}

/** Typed, machine-branchable rejection so the poll loop can log and retry. */
export type EvidenceCommitmentReason =
  | "invalid_version"
  | "invalid_encoding"
  | "empty_evidence"
  | "evidence_too_large"
  | "invalid_fetcher"
  | "invalid_source_url"
  | "stale_evidence"
  | "invalid_council";

export class EvidenceCommitmentError extends Error {
  constructor(
    readonly reason: EvidenceCommitmentReason,
    message: string,
  ) {
    super(message);
    this.name = "EvidenceCommitmentError";
  }
}

/**
 * ASCII unit and record separators, named rather than inlined. They cannot be
 * typed in a URL, and they are stripped from the header fields below, so the
 * only field that may contain them is the evidence body — which is length-framed
 * and therefore unambiguous.
 */
const FIELD_SEPARATOR = String.fromCharCode(0x1f);
const RECORD_SEPARATOR = String.fromCharCode(0x1e);

/** High surrogate not followed by a low one, or a low surrogate not preceded by a high one. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Control characters (including newline) are not allowed in header/council fields. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function fail(reason: EvidenceCommitmentReason, message: string): never {
  throw new EvidenceCommitmentError(reason, message);
}

/** Four-decimal canonical form for q and CE scores (matches the mechanism's rounding). */
function formatScore(value: number): string {
  return value.toFixed(4);
}

function requireFinite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail("invalid_council", `${label} must be a finite number`);
  }
  return value;
}

function validateTally(tally: CouncilTally): string {
  if (!tally || typeof tally !== "object") {
    fail("invalid_council", "council.tally is required");
  }
  const entries: Array<[string, number]> = [
    ["creator", tally.creator],
    ["challengers", tally.challengers],
    ["draw", tally.draw],
    ["unresolvable", tally.unresolvable],
    ["decisive", tally.decisive],
  ];
  for (const [key, value] of entries) {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      fail("invalid_council", `council.tally.${key} must be a non-negative integer`);
    }
  }
  return entries.map(([, value]) => value).join(",");
}

function serializeCouncil(council: CouncilCommitment): string {
  const tally = validateTally(council.tally);
  const qChain = council.qChain ?? [];
  const scores = council.scores ?? [];
  if (qChain.length !== scores.length) {
    fail("invalid_council", "council.qChain and council.scores must align");
  }
  const hasReference = council.referenceQ !== undefined;
  if (hasReference && qChain.length === 0) {
    fail("invalid_council", "council.referenceQ requires a non-empty qChain");
  }
  for (const q of qChain) {
    const value = requireFinite(q, "council.qChain entry");
    if (value < 0 || value > 1) fail("invalid_council", "council.qChain entries must be in 0..1");
  }
  const referenceQ = hasReference
    ? requireFinite(council.referenceQ, "council.referenceQ")
    : undefined;
  if (referenceQ !== undefined && (referenceQ < 0 || referenceQ > 1)) {
    fail("invalid_council", "council.referenceQ must be in 0..1");
  }
  for (const score of scores) {
    const value = requireFinite(score, "council.scores entry");
    // Matches the scoring rule's bound so a corrupt/duplicated ballot cannot be committed.
    if (Math.abs(value) > 100) fail("invalid_council", "council.scores entries must be within ±100");
  }
  return [
    "council",
    `tally:${tally}`,
    `q:${qChain.map(formatScore).join(",")}`,
    `refQ:${referenceQ === undefined ? "" : formatScore(referenceQ)}`,
    `scores:${scores.map(formatScore).join(",")}`,
  ].join(FIELD_SEPARATOR);
}

function validateSourceUrl(sourceUrl: string | null | undefined): string {
  if (sourceUrl === null || sourceUrl === undefined) return "";
  if (typeof sourceUrl !== "string") fail("invalid_source_url", "sourceUrl must be a string");
  const trimmed = sourceUrl.trim();
  if (trimmed === "") return "";
  if (CONTROL_CHARS.test(trimmed)) {
    fail("invalid_source_url", "sourceUrl must not contain control characters");
  }
  if (!/^https?:\/\/\S+$/i.test(trimmed)) {
    fail("invalid_source_url", "sourceUrl must be an http(s) URL");
  }
  return trimmed;
}

function validateEvidence(evidence: string): Buffer {
  if (typeof evidence !== "string") {
    fail("invalid_encoding", "evidence must be a string");
  }
  if (evidence.trim() === "") {
    // Callers always substitute a deterministic placeholder, so an empty body is
    // a bug in the caller — fail closed rather than commit a hash for nothing.
    fail("empty_evidence", "evidence is empty; commit a placeholder instead");
  }
  if (LONE_SURROGATE.test(evidence)) {
    // Buffer.from would silently replace it with U+FFFD and the digest would no
    // longer describe the bytes the model read.
    fail("invalid_encoding", "evidence contains an unpaired UTF-16 surrogate");
  }
  const bytes = Buffer.from(evidence, "utf8");
  if (bytes.length > MAX_EVIDENCE_COMMITMENT_BYTES) {
    fail(
      "evidence_too_large",
      `evidence is ${bytes.length} bytes; max is ${MAX_EVIDENCE_COMMITMENT_BYTES}`,
    );
  }
  return bytes;
}

function assertFresh(fetchedAt: number | null | undefined, now: number): void {
  if (fetchedAt === null || fetchedAt === undefined) return;
  if (typeof fetchedAt !== "number" || !Number.isFinite(fetchedAt) || fetchedAt <= 0) {
    fail("stale_evidence", "fetchedAt must be a positive epoch ms");
  }
  if (now - fetchedAt > MAX_EVIDENCE_AGE_MS) {
    fail(
      "stale_evidence",
      `evidence is ${Math.round((now - fetchedAt) / 1000)}s old; max is ${MAX_EVIDENCE_AGE_MS / 1000}s`,
    );
  }
}

/**
 * The exact bytes SHA-256 is taken over, in a documented order:
 *
 * ```text
 * mimir-evidence-commitment
 * version:1
 * fetcher:<kind>
 * source:<url or empty>
 * bytes:<n>
 * <0x1e>
 * <n UTF-8 bytes of the evidence body>
 * <0x1e>
 * council:<canonical record or "none">
 * ```
 *
 * `bytes:<n>` makes the split explicit: no value inside the untrusted body can
 * forge a boundary because the length is fixed in the header before it. The
 * evidence body is the only field permitted to contain separators.
 */
export function canonicalEvidenceBytes(input: EvidenceCommitmentInput): Buffer {
  if (!FETCHER_KINDS.includes(input.fetcher)) {
    fail("invalid_fetcher", `unknown fetcher kind: ${String(input.fetcher)}`);
  }
  const evidenceBytes = validateEvidence(input.evidence);
  const sourceUrl = validateSourceUrl(input.sourceUrl);
  assertFresh(input.fetchedAt, input.now ?? Date.now());

  const header = [
    "mimir-evidence-commitment",
    `version:${EVIDENCE_COMMITMENT_VERSION}`,
    `fetcher:${input.fetcher}`,
    `source:${sourceUrl}`,
    `bytes:${evidenceBytes.length}`,
  ].join("\n");

  const council = input.council ? serializeCouncil(input.council) : "none";

  return Buffer.concat([
    Buffer.from(header, "utf8"),
    Buffer.from(RECORD_SEPARATOR, "utf8"),
    evidenceBytes,
    Buffer.from(RECORD_SEPARATOR, "utf8"),
    Buffer.from(`council:${council}`, "utf8"),
  ]);
}

/** SHA-256 over {@link canonicalEvidenceBytes}, as 64 lowercase hex characters. */
export function evidenceCommitmentHash(input: EvidenceCommitmentInput): string {
  return sha256Bytes(canonicalEvidenceBytes(input)).toString("hex");
}

/**
 * SHA-256 over the evidence text's UTF-8 bytes alone, no framing.
 *
 * This is the "re-fetch and hash it yourself" value: it depends only on the
 * public body, so a reader does not need the oracle's fetcher metadata to check
 * that the committed evidence matches what the URL served. The on-chain digest is
 * the framed commitment; this is the sub-digest a verifier compares first.
 */
export function evidenceContentHash(evidence: string): string {
  return sha256Bytes(validateEvidence(evidence)).toString("hex");
}

/**
 * Constant-shape verification helper for a reader holding the canonical bytes.
 * Mirrors what a re-fetch + re-encode would compare against the on-chain value.
 */
export function verifyEvidenceCommitment(input: EvidenceCommitmentInput, expectedHash: string): boolean {
  try {
    return evidenceCommitmentHash(input) === expectedHash.trim().toLowerCase().replace(/^0x/, "");
  } catch {
    return false;
  }
}
