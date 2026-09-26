# Canonical evidence commitment

`evidence_hash` is the oracle's only off-chain artefact that lands on chain. It
must be a commitment: somebody holding the resolution URL and the settlement
payload should be able to reproduce the exact bytes and check the digest the
contract stored.

## What changed

Before this change the oracle hashed an ad-hoc string:

```ts
sha256(utf8(evidenceText + "\n[council]" + JSON.stringify(councilMetadata)))
```

That is not a commitment, for three reasons:

1. **Boundary forgery.** `evidenceText` is whatever the resolution page served.
   Concatenation does not record where the body ends, so a page could contain a
   line that looks like council metadata and two different settlements could
   produce the same digest.
2. **Non-canonical JSON.** `JSON.stringify` follows insertion order, so equal
   records can serialise differently and a digest they disagree on commits to
   neither.
3. **Ill-formed strings.** An unpaired UTF-16 surrogate is silently replaced with
   U+FFFD during UTF-8 encoding, so two different strings can hash identically and
   the digest stops describing what the model read.

The oracle, and the paid `POST /api/oracle` preview, now commit
`evidenceCommitmentHash(...)` from
[`lib/evidence-commitment.ts`](../lib/evidence-commitment.ts).

## The canonical byte layout (version 1)

```text
mimir-evidence-commitment
version:1
fetcher:<coingecko-api|direct|jina|bot-paid|none>
source:<resolution URL or empty>
bytes:<n>
<0x1e>
<n UTF-8 bytes of the evidence body>
<0x1e>
council:<canonical record or none>
```

- `bytes:<n>` in the header makes the split explicit. The untrusted body is the
  only field allowed to contain `0x1e` / `0x1f`, and it is length-framed, so no
  page content can forge a boundary.
- The council record is `council`, `tally:...`, `q:...`, `refQ:...`, `scores:...`
  joined by `0x1f`, with each number fixed to four decimals. Key order and number
  formatting are fixed, so two encoders of the same vote produce the same bytes.
- The digest is SHA-256 (bare lowercase hex, 64 chars), the client-side twin of
  Soroban's `env.crypto().sha256()`, so a contract could recompute it.

## Privacy

The input type is a whitelist. Only the evidence body, the fetch route, the
resolution URL and the public council tally/q-chain/scores can enter the bytes.
Prompts, raw model reasoning, wallet and payout addresses, x402 payment hashes and
prices, and analytics/user identifiers are unrepresentable and are **never**
hashed. This is asserted by tests.

## Failure behavior

The boundary fails closed; `evidenceCommitmentHash` throws
`EvidenceCommitmentError` with a typed `reason` instead of returning a digest for
anything it cannot canonicalise:

| Situation | `reason` | Effect |
| --- | --- | --- |
| unpaired surrogate / non-string | `invalid_encoding` | settlement aborts, retried next poll |
| empty or whitespace-only body | `empty_evidence` | settlement aborts (callers pass a placeholder) |
| body over 64 KiB | `evidence_too_large` | settlement aborts |
| unknown fetcher kind | `invalid_fetcher` | settlement aborts |
| malformed resolution URL | `invalid_source_url` | settlement aborts |
| snapshot older than 15 min | `stale_evidence` | settlement aborts; a cache hit is never committed as fresh |
| corrupt / misaligned council record | `invalid_council` | settlement aborts |
| fetch dependency failure | — | callers pass their deterministic placeholder text; the digest is stable across polls |

Duplicate input is content-addressed: identical canonical bytes yield an identical
digest, which is intended. Duplicate council ballots are rejected upstream in
`agents/oracle/council-vote.ts`. Cancelled claims are never passed here — the
oracle does not settle them and `gatherCouncilVerdict` returns `null` first.

## Verification

1. Re-fetch the claim's `resolution_url` through the same route (API handler,
   direct fetch, or Jina fallback).
2. Rebuild the payload, including the council record when one is published.
3. `evidenceCommitmentHash(payload)` must equal the on-chain `evidence_hash`.

`evidenceContentHash(text)` is a convenience sub-digest over the body's UTF-8
bytes alone, for readers who only want to check the public body before rebuilding
the full framed commitment.

## Read-index storage

`lib/ops/projection.ts` stores `evidenceHash` from `ClaimResolved` events into the
read-index. Since projection v1:

- A valid 32-byte hex digest (bare or `0x`-prefixed) is preserved verbatim.
- A malformed value (e.g. a legacy placeholder like `"sha256:fixture-evidence"`, a
  truncated hash, or any non-hex string) is stored as `null` rather than written
  through. This keeps the fingerprint stable and ensures the cache never holds a
  hash that `decodeHash32Hex` would reject at the contract boundary.

No data migration is required: any `evidenceHash` already in the read-index that
passes `isHash32Hex` is kept, and those that do not are replaced with `null` on the
next resync.

## Council bonus confirmation

`isConfirmedCouncilSettlement` in `agents/oracle/council-vote.ts` gates the
post-settlement bonus payout. It compares the local `evidenceHash` against
`claim.evidence_hash` read back from the contract. Both values are normalized
before comparison: any `0x` prefix is stripped and both sides are lowercased. This
matches the normalization applied by `verifyEvidenceCommitment` and ensures the
comparison is correct regardless of which encoding path produced each value.

## Migration and rollback

- Digests have a new meaning: the previous value was a hash over a plain string
  concatenation. Existing `evidence_hash` values will not match a freshly computed
  commitment. This is a data-migration question, not something hashing can paper
  over — see the note in [`lib/content-hash.ts`](../lib/content-hash.ts).
- On Stellar Testnet there is no production escrow to reconcile: old hashes remain
  on their resolved claims for display, and every new settlement uses version 1.
- Rollback is a code revert, not an env toggle: there is deliberately no switch to
  restore the ambiguous concatenation. The settled-on-chain digest is the record,
  and it is not rewritten by a redeploy.
