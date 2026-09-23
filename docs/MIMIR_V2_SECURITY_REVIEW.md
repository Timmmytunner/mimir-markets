# Mimir market contract security review

Original EVM review: 2026-08-12, against `contracts/MimirV2.sol`.
Rewritten for the Soroban contracts: 2026-08-19.

## Status: superseded, and not yet replaced

**Read this first.** The findings below were produced against a Solidity contract
that no longer exists in this repository. Mimir's market and squad logic now lives
in `contracts-soroban/mimir-market` and `contracts-soroban/mimir-squad` (Rust /
Soroban). The *economic* properties survived the port and are re-tested there — see
`ECONOMIC_INVARIANTS.md`, which cites the specific tests. The *security* findings did
not survive, because most of them were about EVM mechanics.

Rewriting this file is a documentation pass. **It is not an audit.** A fresh security
review of the Soroban contracts is a separate, real undertaking: a different language,
a different VM, a different authorization model, and a different tooling set (no
Slither; `cargo test`, `cargo clippy`, fuzzing and a Soroban-literate human reviewer
instead). `LAUNCH_GATE_STATUS.md` tracks it as an open external gate, and nothing in
this document should be read as closing it.

## What the port removed from the attack surface

These were real concerns on the EVM and have no Soroban counterpart:

- **Reentrancy / `nonReentrant`.** The Soroban host rejects a call that re-enters a
  contract already on the call stack. There is no guard because there is nothing to
  guard. The ordering discipline (state written before an external transfer) is kept
  anyway, since it is also what makes the pull paths correct.
- **`approve` front-running.** Staking uses no allowance at all. Soroban authorises
  per invocation: `challenge_claim` carries an authorisation entry permitting exactly
  one USDC transfer of exactly the staked amount. There is no standing allowance to
  race, to leave behind, or to set to zero first.
- **Gas-bounded loops.** `resolve_claim` no longer loops over challengers, so
  "fee accrual writes occur in a loop bounded by `MAX_CHALLENGERS`; the deployment and
  gas limits must retain that bound" is gone. The constraint on Soroban is the
  transaction's ledger-entry footprint, and the answer is structural rather than a
  bound to be preserved: settlement seeds `remaining_escrow` and each challenger pulls
  their own share in an O(1) call.
- **Payable receiver / native value.** There is no payable invocation on Soroban. XLM
  is the ledger fee, never an argument, so a native-value rejection has nothing left to
  reject.
- **`viaIR`, optimizer settings, bytecode size, compiler pinning.** Not applicable.
  The build is `cargo` against a pinned `soroban-sdk`; `Cargo.lock` is committed.
- **`msg.sender`.** There is no equivalent for a top-level Soroban call, so every
  beneficiary and every spender is an explicit argument that must itself authorise —
  `withdraw(who)`, `claim_fees(who)`, `claim_challenger_payout(challenger, claim_id)`.
  Tested: `pulling_requires_the_challengers_signature`.

## What the port kept, and why

- **Exact balance-delta intake.** `escrow::pull` asserts escrow moved by exactly the
  requested atomic amount and errors `UnsupportedToken` otherwise. Strict equality is
  intentional: accepting a smaller or larger delta would make escrow accounting
  incorrect. This still matters — a Stellar Asset Contract for a well-behaved asset
  will not deviate, but a misconfigured deployment pointing `usdc` at some other token
  would.
- **Push-with-pull-fallback for payouts.** On Base the motivating case was a
  blacklisted USDC recipient making `transfer` revert. Soroban has no blacklist, but a
  *frozen or authorization-revoked trustline* makes the SAC transfer fail the same way,
  so `escrow::push_or_park` uses `try_transfer` and parks the amount as a withdrawable
  balance rather than failing the whole settlement. Tested:
  `a_failed_payout_is_parked_and_withdrawable_later`,
  `a_blocked_challenger_has_their_payout_parked`.
- **Pull-based fee accrual.** Fees accrue per recipient and are collected with
  `claim_fees`, never pushed.
- **The immutable fee cap.** `MAX_TOTAL_FEE_BPS = 1_000` is checked on `initialize` and
  on every queued change; no function can raise it. `FEE_TIMELOCK_SECONDS` gates
  execution at 2 days, and execution is permissionless once elapsed so the owner cannot
  hold a favourable policy hostage or push one through early.
- **Owner/oracle gating and checked arithmetic.** `set_oracle` and
  `transfer_ownership` are owner-gated (`ownership_and_oracle_transfer_are_owner_gated`);
  every multiplication in `fees.rs` is `checked_mul` and errors `Overflow` rather than
  wrapping, matching the revert-on-overflow semantics the Solidity relied on.
- **Timestamp comparisons.** Still used for deadlines and the fee timelock, now read
  from `env.ledger().timestamp()`.

## Soroban-specific surface a real review must cover

Listed so the gap is explicit, not to imply any of it has been assessed:

- Authorization: every `require_auth` site, and whether any path can be invoked with
  authorization from the wrong subject.
- Storage: instance vs. persistent vs. temporary choice per key, and TTL/archival
  behaviour for long-lived claims and roster entries.
- Ledger-entry footprint under adversarial input, including a claim filled to
  `MAX_CHALLENGERS` and the `MAX_INVITE_KEY_BYTES` hashing path.
- Cross-contract behaviour against the USDC Stellar Asset Contract, including
  `try_transfer` failure modes.
- Contract-account (`C…`) callers reaching any entry point that assumes a `G…`
  account.
- Upgrade/admin surface and key custody for the `owner` and `oracle` addresses.

## Operational requirement

Deployment must pass the Stellar Asset Contract id for **Circle's official Testnet
USDC issuer**, derived from that issuer rather than chosen —
`stellar contract id asset --asset USDC:<issuer> --network testnet`. The deploy
script (`deploy/deploy.ts`), `npm run verify:deployment` and the env validation in
`lib/stellar.ts` are the configuration boundary; the contract additionally proves each
stake transfer changes escrow by the exact requested atomic amount. Note that USDC on
Stellar reports **7** decimals, not 6, and `lib/usdc.ts` confirmed this by invoking
`decimals()` on the live SAC rather than assuming it. Both contracts now also enforce
it on chain: `initialize` rejects a token whose `decimals()` is not `USDC_DECIMALS`
(7) with `UnsupportedDecimals`.
