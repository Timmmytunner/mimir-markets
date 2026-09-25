# Saved ledger replay

The saved-ledger check reconstructs Mimir's read index from a reviewed chain
capture without RPC access, a database, wallet seeds, or production secrets:

```bash
npm ci
npm run check:ledger-fixture
```

Use `npm run replay:ledger -- path/to/fixture.json` for another versioned
fixture. The command writes one JSON artifact to stdout with source ledger bounds,
the fingerprint and resume cursor, and deterministic read-index rows. Stderr
contains only the local path and an actionable validation reason; it never dumps
the fixture, environment, or secrets.

## Fixture contract and safety

- Atomic USDC values are base-10 strings; JavaScript numbers are rejected.
- Events must be inside the declared capture range. Conflicting events at one
  ledger/event-index position are rejected.
- Orphan events fail replay. Partial captures cannot represent a funded index.
- The reviewed `expectedFingerprint` makes event or money drift fail closed.
- Stellar addresses retain exact case.
- Replay is offline and read-only: no Postgres update, transaction, live cursor,
  `.env`, or secret is involved.

Fixtures may contain public chain data only. Never save seeds, API keys, database
URLs, private invite material, or unredacted off-chain customer data.

## Release, operations, and rollback

Run `npm run check:ledger-fixture` with typecheck, lint, node tests, contract
tests, and release checks. Failure blocks release: repair a partial capture or
review an intentional projection change and its new fingerprint in the same pull
request. Never bypass the check or copy fixture rows directly into production.

The runtime worker stays chain-first and no migration, environment variable, or
deployment secret is added. Roll back the projection and fixture together, rerun
release checks, and redeploy the sync worker. If live reconciliation is suspect,
stop the worker, retain the privacy-safe failure artifact, and rebuild the
disposable read index from authoritative chain reads before resuming funded read
surfaces.

Pull requests changing replay or projection must link the tracking issue and
state artifact results, release impact, rollback plan, and operational impact.
