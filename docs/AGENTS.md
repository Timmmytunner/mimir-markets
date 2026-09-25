# AGENTS.md — Mimir

This repository contains Mimir, an AI-settled prediction market on
**Stellar Testnet** (network passphrase `Test SDF Network ; September 2015`,
CAIP-2 `stellar:testnet`).

See `docs/STELLAR_NETWORK.md` for the one-page architecture reference.

## Repository layout

| Path | Purpose |
|------|---------|
| `contracts-soroban/mimir-market/` | Rust/Soroban market contract (USDC escrow, settlement, fee policy) |
| `contracts-soroban/mimir-squad/` | Rust/Soroban two-sided squad pools |
| `lib/stellar.ts` | Stellar Testnet config (RPC/Horizon, passphrase, explorer links, `getEvents` scans) |
| `lib/usdc.ts` | Circle Testnet USDC: Stellar Asset Contract id, issuer, 7-decimal helpers |
| `lib/contract.ts` | TypeScript contract client (reads + writes through the generated bindings) |
| `lib/wallet.tsx` | Wallet context (Stellar Wallets Kit: Freighter, xBull, Albedo, Lobstr, Hana) |
| `lib/wallet-connectors.ts` | Connector list and per-wallet capability matrix |
| `lib/stellar-message.ts` | SEP-43 `signMessage` verification (Ed25519, base64) |
| `lib/content-hash.ts` | SHA-256 content hashing — the hash Soroban's host exposes |
| `lib/agent-wallets.ts` | Local Stellar keypairs for oracle / creator / council |
| `lib/agents/wallet-adapter.ts` | Vendor-neutral wallet boundary + budget policy for BYOA |
| `lib/agents/spend-permissions.ts` | Owner-signed spend permissions over the USDC SAC allowance |
| `lib/x402/config.ts` | Network, prices and Bazaar metadata for every paid endpoint |
| `lib/x402/stellar-scheme.ts` | The Stellar-native x402 `exact` scheme (buyer, seller, verification) |
| `lib/x402/server.ts` | x402 v2 seller paywall (`@x402/next`) + settlement recording |
| `lib/x402/buyer.ts` | x402 v2 buyer with a hard USDC budget cap (`@x402/fetch`) |
| `agents/oracle/index.ts` | Off-chain AI oracle agent (LLM + local keypair) |
| `agents/market-creator/index.ts` | Autonomous market creator (LLM + local keypair) |
| `agents/council/` | Ten AI personas that stake as economic actors |
| `fixtures/ledger/` | Versioned public-chain captures for deterministic offline replay |
| `deploy/deploy.ts` | Soroban build/deploy/initialize script |
| `deploy/contract-artifacts.manifest.json` | Pinned Wasm digests for fail-closed provenance checks |
| `lib/ops/artifact-provenance.ts` | Offline SHA-256 artifact provenance verifier |
| `lib/ops/cache-backup.ts` | Offline read-index cache-backup verifier (checksum + privacy, no network) |
| `lib/server/read-index-backup.ts` | DB-backed read-index dump / verified restore (restore fingerprint check) |
| `scripts/verify-artifact-provenance.ts` | CLI: verify or `--write-pins` contract artifacts |
| `scripts/verify-cache-backup.ts` | CLI: offline cache-backup verification (`npm run verify:cache-backup`) |
| `scripts/backup-read-index.ts` | CLI: dump the Neon read-index to a self-verified archive |
| `scripts/restore-read-index.ts` | CLI: restore a verified archive and fingerprint-check the cache |
| `scripts/stellar-keys.ts` | Keypairs + Friendbot funding + USDC trustline |
| `scripts/create-agent-wallets.ts` | Generate 12 keypairs (oracle + creator + 10 personas) |
| `scripts/fund-agents.ts` | Fund agent accounts from a master seed |
| `scripts/check-forbidden-terms.mjs` | Guardrail: no pre-Stellar chain or bespoke-402 residue |
| `scripts/run-browser-smoke.mjs` | Browser smoke orchestrator: build + serve + test + teardown in a secret-free env |
| `scripts/lib/browser-smoke-env.mjs` | The smoke harness's strict env allowlist (what a smoke build may see) |
| `tests/browser/` + `playwright.config.ts` | Playwright browser smoke suite (run via `npm run smoke:browser`) |

## Browser smoke flow (must stay green on release)

`npm run smoke:browser` builds the app with a **secret-free allowlist**, serves it
locally, drives the Playwright suite in `tests/browser/` with the system
Chrome/Chromium, and tears down. CI runs it as the `browser-smoke` job. When you
add a page, a wallet gate, or an env-read, keep it green:

- **Never let real settings into the smoke build.** The harness moves every
  `.env*` file aside during the run and builds with only `buildSmokeEnv()` keys.
  If the app needs a new `NEXT_PUBLIC_*` value to even build, add it to
  `SMOKE_NEXT_PUBLIC` **and** its regression test — but that must be a value that
  is safe to ship to the browser in every build.
- **Assert the unconfigured state, not a live one.** The smoke run has no DB, no
  contract ids, no secrets. It pins fail-closed behavior: health 503 `critical` /
  `db.unconfigured`, empty arena feed, money paths gated behind a connect control.
  Do not add an assertion that depends on a live deployment.
- **New public pages go into `tests/browser/pages.spec.ts`** with a signature
  heading marker from `messages/en.json`.
- **New secret-shaped env vars**: if you add one, confirm it is **not** in the
  smoke allowlist; add it to the secret samples in `tests/node/browser-smoke-env.test.ts`.
- Run it before finishing a release-touching PR: `npm run smoke:browser`.

## Key rules

- Contract state is the source of truth. Neon Postgres is a read-index cache only.
- **Two assets, one job each.** Native **XLM** pays the ledger fee and the account
  reserve, and nothing else — it is never an argument to a contract call, because
  Soroban has no payable invocation. **USDC** (7 decimals, Circle's Testnet issuance
  reached through its Stellar Asset Contract) carries every value flow: market
  stakes, payouts, agent bankrolls and x402 payments.
- **Every account funds its own fees.** There is no sponsorship, by product
  decision: an operation costs ~100 stroops, so there is nothing worth sponsoring.
- Stakes need **no allowance**. Soroban authorises per invocation:
  `challenge_claim` carries an authorisation entry permitting exactly one USDC
  transfer of exactly the staked amount. `lib/contract.ts` builds one transaction,
  the user signs once. Allowances (`lib/agents/spend-permissions.ts`) exist only for
  the delegated BYOA case.
- **A first-time account signs twice, once.** A USDC trustline is a classic
  operation and a transaction containing a Soroban operation must contain exactly
  one operation, so the trustline cannot ride along with the stake.
- Resolution is oracle-only. `resolve_claim` requires authorisation from the
  `oracle` address stored in the contract. Do not expose user-triggered resolution.
- **Challenger settlement is pull-based.** `resolve_claim` deliberately does not
  loop over challengers: a transaction is capped on its ledger-entry footprint and
  ~100 challengers do not fit. It seeds `remaining_escrow`; each winner calls
  `claim_challenger_payout` once, O(1), and the last claimant absorbs the dust.
  `withdraw` and `claim_fees` are the other two pull paths.
- Hash with **SHA-256** (`lib/content-hash.ts`), never keccak. `env.crypto().sha256()`
  is the Soroban host primitive, so a contract can recompute the digest; there is no
  keccak host function. Both are 32 bytes, so every `BytesN<32>` field takes it
  unchanged — but a pre-migration digest will not match a fresh one.
- Agents sign with **local Stellar seeds** held only in the worker process env
  (`STELLAR_ORACLE_SECRET`, `CREATOR_SECRET`, `COUNCIL_<SLUG>_SECRET`). The web
  server never sees a seed — only `G…` addresses for display and payment routing.
- **`G…`/`C…` strkeys are case-sensitive base32.** Never lowercase one for
  comparison; the EVM `toLowerCase()` habit turns a valid address into one that
  matches nothing.
- Paid endpoints speak **x402 v2** only, in the Stellar-native `exact` scheme: the
  buyer submits its own USDC `Payment` and presents a signed proof; the seller reads
  the transaction back off Horizon. No facilitator, no HTTP third party. Never
  reintroduce manual transaction inspection or custom payment headers.
- Money is accounted in **atomic integers**. `payments_v2.amount_atomic` is
  `NUMERIC(78,0)`; decimals are applied at the API/UI edge only.
- When a contract in `contracts-soroban/` changes, regenerate bindings
  (`npm run stellar:bindings`) and keep `lib/contract.ts` in sync.
- Categories: `sports`, `weather`, `crypto`, `culture`, `custom` (English).
- Sync/read-index changes must pass `npm run check:ledger-fixture`; see
  `docs/LEDGER_REPLAY.md` for artifact, secret, release, and rollback policy.

## Oracle agent

```bash
# Start the oracle (needs STELLAR_ORACLE_SECRET + an LLM key)
npm run oracle
```

The oracle polls for active claims past their deadline, fetches evidence,
evaluates with an LLM, and sends `resolve_claim` to the contract on Stellar Testnet.

## Agents bootstrap

```bash
# 1. Generate all twelve keypairs (writes seeds + addresses into .env.local)
npm run agents:create-wallets

# 2. Fund from a master account (Friendbot tops up the master only).
#    Each agent needs test USDC for stakes plus a little XLM for fees and reserve.
npm run agents:fund

# 3. Deploy and initialize the contracts
npm run deploy:contract

# 4. Verify artifact provenance (no secrets), then the live deployment
npm run verify:artifacts
npm run verify:deployment
npm run smoke:onchain

# 5. Run workers
npm run workers   # oracle + market-creator + council + sync + traders
```

Buying data over x402 needs no sponsor and no separate approval: the agent pays
its own ~100-stroop fee and its own USDC. XLM is required for every write the
agent makes, including those payments.

Faucets: XLM from Friendbot (https://lab.stellar.org/account/fund), test USDC from
https://faucet.circle.com
Explorer: https://stellar.expert/explorer/testnet
Public endpoints (rate-limited): https://soroban-testnet.stellar.org and
https://horizon-testnet.stellar.org

## Read-index cache backup / restore (devx)

The Neon read-index is a cache, so its backup workflow is deliberately
**verifiable without any network credentials** — that is what makes the safety
property testable on a clean checkout and in CI.

- **Backup** (`npm run backup:read-index -- --out backups/x.json`) needs only
  `DATABASE_URL`. It dumps the projection tables (`claims`, `challengers`,
  `sync_meta`, `market_settlements`, `fee_accruals`, `fee_claims`,
  `fee_policies`, `agent_revenue_attribution`) and refuses to emit a byte unless
  its own checksum and privacy invariants pass. No seeds, no RPC, no LLM keys.
- **Verify** (`npm run verify:cache-backup -- <file>`) is a pure SHA-256 +
  schema + privacy check (`lib/ops/cache-backup.ts`). Fail-closed findings:
  `BACKUP_INVALID`, `BACKUP_KIND_MISMATCH`, `BACKUP_SCHEMA_UNSUPPORTED`,
  `BACKUP_MISSING_TABLE`, `BACKUP_UNKNOWN_TABLE`, `BACKUP_EMPTY`,
  `BACKUP_CHECKSUM_MISMATCH`, `BACKUP_PRIVATE_CONTENT_LEAK`. A private claim's
  scrubbed content fields must stay `null` in the archive.
- **Restore** (`npm run restore:read-index -- <file> [--dry-run]`) requires
  `DATABASE_URL`. An unverified archive is refused before any write; writes run
  in one transaction so a failure rolls back; afterwards the cache is re-read
  and its fingerprint is compared against the archive's checksum.
- **Rollback**: restore any verified archive, or — because contract state is
  the source of truth — re-warm from chain (`npm run warm:vs-index` / `npm run
  sync`). Restoring never writes to the chain.
- **Adding a table/column to the projection**: update `TABLE_SPECS` in
  `lib/server/read-index-backup.ts` **and** the regression-pinned
  `READ_INDEX_TABLES` list in `lib/ops/cache-backup.ts`, then regenerate the
  `valid.json` fixture. A column added to Postgres but not to `TABLE_SPECS` is
  intentionally never backed up — this is a feature (a secret-shaped column
  cannot sneak into archives) and it fails loud if you forget to wire it.
- Never commit real archives to the repo. The committed fixture in
  `tests/fixtures/cache-backup/valid.json` is synthetic.
