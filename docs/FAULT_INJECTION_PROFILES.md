# Fault-injection profiles

`lib/ops/fault-injection.ts` defines a registry of **local-stack fault profiles** — machine-readable runbooks for the failure modes Mimir must survive. Each profile names a component, a fault kind, and a deterministic, secret-free environment that reproduces the failure on any checkout.

The runner (`scripts/run-fault-injection-profile.ts`) prints the runbook and evaluates the in-process parts of each probe without touching a network or database.

---

## Quick start

```bash
# list all profiles
npm run fault:profile

# run one profile
npm run fault:profile -- --profile db-not-configured

# run every profile
npm run fault:profile -- --all

# run only money-path profiles
npm run fault:profile -- --category money

# machine-readable output (one JSON object per profile, no prose)
npm run fault:profile -- --profile paid-seller-paused --json
npm run fault:profile -- --all --json
```

No `.env.local`, no Stellar keys, no database: `npm run fault:profile` is reproducible from a clean checkout.

---

## What profiles exist

| id | component | fault | category | what it verifies |
|----|-----------|-------|----------|-----------------|
| `db-not-configured` | postgres | not_configured | read | App boots without a read-index; health reports `db.unconfigured`. |
| `db-unreachable` | postgres | unreachable | read | Postgres port is closed; health reports `db.claims_unreadable`. |
| `stellar-rpc-unreachable` | stellar_rpc | unreachable | money | Soroban RPC is unreachable; chain reads fail and money paths refuse. |
| `stellar-horizon-unreachable` | stellar_horizon | unreachable | money | Horizon is unreachable; x402 payment verification refuses. |
| `stellar-passphrase-mismatch` | stellar_rpc | wrong_passphrase | money | Wrong network identity; proofs bind to nothing (`network_mismatch`). |
| `paid-seller-paused` | api_route | refused | money | `MIMIR_PAUSE_X402_SELLING=1`; paid endpoints gate on `x402_selling`. |
| `chain-not-configured` | api_route | not_configured | money | No contract ids; market reads fail and money paths are gated. |
| `worker-settlement-stale` | worker | stale | ops | Stale oracle heartbeat; health alarms `worker.oracle.stale` + `settlement.overdue`. |

---

## Probe types

Profiles fall into two probe types. The runner handles both automatically.

### In-process probes

Profiles that can be fully evaluated without a running server:

- **`paid-seller-paused`** — exercises the real `isPaused` / `pauseState` evaluators from `lib/ops/flags.ts`. The probe passes when the injected env flips the gate.
- **`worker-settlement-stale`** — simulates a stale oracle heartbeat and an overdue settlement against the real `evaluateHealth` from `lib/ops/health.ts`. The probe passes when both alarm ids appear.

### Server-side probes (env + structure only)

Profiles that require a running Next.js dev server are structurally validated (env builds, loopback guard, deny-only rule) and their injection environment is printed. You verify the expected markers manually:

1. Copy the env block from the runner output.
2. Add the keys to `.env.local` (or export them in your shell).
3. Run `npm run dev`.
4. Hit the relevant endpoint and confirm the expected marker appears (alarm id, refusal reason, HTTP status).
5. Remove the injected keys and restart to roll back.

---

## The security contract

A fault profile may only ever **deny**. The validator enforces this:

- Only keys listed in `FAULTABLE_ENV_KEYS` may appear in a profile's env.
- URL-shaped keys must point at a loopback address (`127.0.0.1`, `localhost`, `::1`).
- Pause keys (`MIMIR_PAUSE_*`) may only be set to `"1"` — lifting a control would be a grant, not a fault.
- `secrets: "none"` is required; no profile may hold or require production credentials.

Any profile that violates these rules is refused by `validateFaultProfile` before `buildFaultEnv` runs, so a mis-authored profile fails loud at construction time rather than silently at execution time.

---

## Adding a profile

1. Open `lib/ops/fault-injection.ts`.
2. Add a key to the `FAULT_PROFILES` object that satisfies the `FaultProfile` interface.
3. If the new profile needs a new env key, add it to `FAULTABLE_ENV_KEYS` first (and explain why in the PR).
4. Run `npm run fault:profile -- --all` — the new profile must pass its in-process checks.
5. If the profile has an in-process evaluator (a pause gate, a health signal), add the probe branch to `runInProcessProbe` in the runner and a matching assertion to `tests/node/fault-injection.test.ts`.

---

## Running in CI

`npm run fault:profile -- --all` exits 0 when all in-process probes pass, 1 otherwise. It is offline and secret-free, so it can run as a CI step without any environment setup.

The full test suite for this module is:

```bash
node --import tsx --test tests/node/fault-injection.test.ts
```
