# Economic invariant evidence

This is repository evidence, not an independent audit. Every claim below is
backed by a test in this repo; the cross-references name the file so a reader can
check rather than trust.

Amounts throughout are atomic USDC at **7 decimals**, the decimals the Circle
Testnet USDC Stellar Asset Contract actually reports (see `lib/usdc.ts`, which
verified it by invoking `decimals()` on the live SAC). `MIN_STAKE` is therefore
`2_0000000`.

Both contracts enforce that scale on chain rather than assuming it: `initialize`
reads `decimals()` off the token and rejects anything but `USDC_DECIMALS` (7) with
`UnsupportedDecimals`, and a token that cannot answer `decimals()` with
`UnsupportedToken`. A rejected call writes nothing. `MIN_STAKE` is derived as
`2 * USDC_UNIT`, so it cannot be read at a scale it was not written for (against a
6-decimal token it would have meant 20 USDC). Tests: `src/test_decimals.rs` in each
crate. They also settle every verdict with the escrow at exactly `i64::MAX`
stroops (the most a classic Stellar account can hold), with no `Overflow` and exact
conservation to the stroop.

## mimir-market fees

Source: `contracts-soroban/mimir-market/src/fees.rs`, mirrored off-chain in
`lib/fees.ts`. Tests: `src/test_fees.rs`, `src/test_settlement.rs`,
`tests/node/fees.test.ts`.

- Fees are charged on **profit only** (`gross - principal`, floored at zero), so a
  winner never receives less than their principal. Integer division truncates,
  which rounds fees down in the participant's favour.
- A fee with no recipient is not charged, so a malformed snapshot cannot mint an
  unclaimable balance.
- Claim creation snapshots platform/agent-owner bps and both recipients onto the
  claim (`FeeSnapshot`); a later policy change cannot rewrite the economics of an
  open market. Tested both ways: `a_later_policy_change_cannot_reach_an_existing_claim`
  and `a_new_claim_picks_up_the_new_policy`.
- `platform_fee_bps + agent_owner_fee_bps` can never exceed `MAX_TOTAL_FEE_BPS`
  (1,000 bps = 10%). No function can raise that constant, so no admin action and
  no compromised key can take more than 10% of profit. Checked on `initialize` and
  on every queued change, including via the queue/execute path.
- A queued policy waits `FEE_TIMELOCK_SECONDS` (2 days) before it can execute, and
  execution is *permissionless* once elapsed — the owner can queue and cancel but
  cannot execute early.
- Fees are **pulled, not pushed**: they accrue per recipient and are collected with
  `claim_fees`. Tested once-only (`fees_are_pulled_not_pushed_and_only_once`) and
  for an unrelated address having nothing to claim.
- Lifetime accrued and claimed totals (`get_platform_stats`) support reconciliation
  against the off-chain atomic ledger.
- Exact-balance intake (`escrow::pull`) rejects fee-on-transfer and rebasing
  behaviour: the contract asserts escrow moved by exactly the requested amount and
  errors with `UnsupportedToken` otherwise.

### Settlement conservation

`conservation_holds_across_every_verdict` asserts, for every `WinnerSide`, that
payouts + fees + dust equals escrow inflow. Alongside it:

- `winner_never_receives_less_than_principal_in_a_crowded_pool`
- `challengers_win_pool_mode_is_pro_rata_and_conserved`
- `pool_mode_truncation_dust_is_absorbed_by_the_last_claimant`
- `fixed_odds_challenger_win_refunds_unspent_liability_without_fee`
- `fixed_odds_with_several_challengers_conserves_exactly`
- `draw_refunds_everyone_in_full_with_no_fee` and the `Unresolvable` equivalent
- `a_quote_matches_what_the_pull_actually_pays`

The off-chain mirror exports `conservationHolds` and `noWinnerLosesPrincipal` from
`lib/fees.ts` and asserts them over the same shapes.

### Pull settlement is a solvency property, not a convenience

`resolve_claim` does not loop over challengers, because a Stellar transaction is
capped on its ledger-entry footprint and a market filled to `MAX_CHALLENGERS`
(100) does not fit. Resolution instead seeds `remaining_escrow`, and each
`claim_challenger_payout` draws it down — so the contract cannot pay out more than
it took in, regardless of ordering. `challenger_claims` counts the pulls so the
last claimant absorbs the truncation dust. Tested: a challenger can only pull
once, a non-challenger cannot pull, pulling before resolution is rejected, pulling
requires the challenger's own signature, and an abandoned share simply stays in
escrow.

A payout the contract cannot deliver — a frozen or authorisation-revoked USDC
trustline makes the Stellar Asset Contract transfer fail — is parked as a
withdrawable balance rather than failing the whole settlement
(`escrow::push_or_park`, tested by `a_blocked_challenger_has_their_payout_parked`).

## mimir-squad

Source: `contracts-soroban/mimir-squad/src/pool.rs`. Tests: `src/test_lifecycle.rs`,
`src/test_payouts.rs`, `tests/node/squad-pool.test.ts`.

- Both sides deposit into one escrow and exact USDC balance deltas are required.
- Before the deadline, participants can withdraw their own side balance; after
  resolution, winners claim pro rata.
- Sum of winner payouts, profit-only fee and deterministic final-winner dust equals
  the escrowed pot (`conservation_holds_over_awkward_stake_distributions`, which
  sweeps every result × three fee levels × deliberately awkward stake sets).
- Participants per side are capped at `MAX_PARTICIPANTS_PER_SIDE` (200), fee bps at
  `MAX_FEE_BPS` (1,000 = 10%), and market duration between `MIN_DURATION` (10
  minutes) and `MAX_DURATION` (365 days).
- Payouts are pull-based for the same footprint reason as the market contract:
  `remaining_escrow` is drawn down by each claim, and the last winner absorbs the
  dust. Claiming twice, claiming from the losing side, claiming with no position and
  claiming without the participant's signature are each rejected.
- A cancelled market refunds every principal in full, including both sides of a
  double-sided depositor. A break-even winner pays no fee.
- `preview_matches_the_amount_actually_paid` ties the quoting view to the pull.

## Virtual baskets

Source: `lib/baskets.ts`. Tests: `tests/node/baskets.test.ts`,
`tests/node/basket-returns.test.ts`.

- Weights equal exactly 10,000 bps and single-agent/category caps are enforced.
- Paused/stale/failed-copy allocation remains idle USDC and cannot fabricate NAV.
- Share/deposit/redemption and high-water-mark calculations use integer rounding
  with explicit dust ownership.
- Funded deposits remain off until the external audit and legal/eligibility gates in
  `LAUNCH_GATE_STATUS.md` are complete.

## Reentrancy

There is no reentrancy guard in these contracts, and that is not an omission: the
Soroban host rejects a call that re-enters a contract already on the call stack, so
the EVM `nonReentrant` modifier has no counterpart to port. The ordering discipline it protected
(state written before an external transfer) is kept anyway, because it is also what
makes the pull paths correct.
