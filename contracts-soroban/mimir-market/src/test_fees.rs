#![cfg(test)]
//! Fee policy: the hard cap, the timelock, the per-claim snapshot, and agent
//! attribution.

extern crate std;

use soroban_sdk::testutils::Address as _;
use soroban_sdk::Address;

use crate::test_common::{Fixture, USDC};
use crate::types::{Error, WinnerSide, FEE_TIMELOCK_SECONDS, MAX_TOTAL_FEE_BPS};

// ── The cap ──────────────────────────────────────────────────────────────────

#[test]
fn initialize_rejects_a_policy_over_the_cap() {
    let env = soroban_sdk::Env::default();
    env.mock_all_auths();
    let contract_id = env.register(crate::contract::MimirMarket, ());
    let client = crate::contract::MimirMarketClient::new(&env, &contract_id);
    let who = Address::generate(&env);

    let err = client
        .try_initialize(&who, &who, &who, &600, &500, &Some(who.clone()))
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::FeeCapExceeded);
}

#[test]
fn initialize_rejects_a_platform_fee_with_no_recipient() {
    let env = soroban_sdk::Env::default();
    env.mock_all_auths();
    let contract_id = env.register(crate::contract::MimirMarket, ());
    let client = crate::contract::MimirMarketClient::new(&env, &contract_id);
    let who = Address::generate(&env);

    let err = client
        .try_initialize(&who, &who, &who, &100, &0, &None)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::FeeNeedsRecipient);
}

#[test]
fn initialize_is_one_shot() {
    let f = Fixture::new(100, 0);
    let err = f
        .client()
        .try_initialize(
            &f.owner,
            &f.oracle,
            &f.token_id,
            &0,
            &0,
            &Some(f.platform.clone()),
        )
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::AlreadyInitialized);
}

#[test]
fn the_cap_cannot_be_exceeded_via_queue_and_execute() {
    let f = Fixture::new(500, 500);

    // Over the cap in total.
    let err = f
        .client()
        .try_queue_fee_policy(&600, &500, &Some(f.platform.clone()))
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::FeeCapExceeded);

    // Over the cap on the platform side alone.
    let err = f
        .client()
        .try_queue_fee_policy(&(MAX_TOTAL_FEE_BPS + 1), &0, &Some(f.platform.clone()))
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::FeeCapExceeded);

    // Nothing was queued, so nothing can be executed.
    assert!(f.client().get_pending_fee_policy().is_none());
    let err = f.client().try_execute_fee_policy().unwrap_err().unwrap();
    assert_eq!(err, Error::NothingQueued);

    // Exactly at the cap is accepted, and the live policy still sums to the cap.
    f.client()
        .queue_fee_policy(&(MAX_TOTAL_FEE_BPS - 250), &250, &Some(f.platform.clone()));
    f.advance_by(FEE_TIMELOCK_SECONDS);
    f.client().execute_fee_policy();
    let policy = f.client().get_fee_policy();
    assert_eq!(
        policy.platform_fee_bps + policy.agent_owner_fee_bps,
        MAX_TOTAL_FEE_BPS
    );
}

#[test]
fn the_timelock_blocks_early_execution() {
    let f = Fixture::new(0, 0);
    f.client()
        .queue_fee_policy(&300, &200, &Some(f.platform.clone()));

    let queued = f.client().get_pending_fee_policy().unwrap();
    assert_eq!(queued.executable_at, f.env.ledger().timestamp() + FEE_TIMELOCK_SECONDS);

    // One second short.
    f.advance_by(FEE_TIMELOCK_SECONDS - 1);
    let err = f.client().try_execute_fee_policy().unwrap_err().unwrap();
    assert_eq!(err, Error::Timelocked);
    assert_eq!(f.client().get_fee_policy().platform_fee_bps, 0);

    // On the second it becomes executable.
    f.advance_by(1);
    f.client().execute_fee_policy();
    assert_eq!(f.client().get_fee_policy().platform_fee_bps, 300);
    assert_eq!(f.client().get_fee_policy().agent_owner_fee_bps, 200);
    assert!(f.client().get_pending_fee_policy().is_none());
}

#[test]
fn execution_is_permissionless_once_the_timelock_elapses() {
    let f = Fixture::new(0, 0);
    f.client()
        .queue_fee_policy(&400, &0, &Some(f.platform.clone()));
    f.advance_by(FEE_TIMELOCK_SECONDS);

    // A lost owner key must not be able to strand an already-public change, so
    // execution requires no authorization at all.
    f.env.set_auths(&[]);
    f.client().execute_fee_policy();
    assert_eq!(f.client().get_fee_policy().platform_fee_bps, 400);
}

#[test]
fn only_the_owner_can_queue_or_cancel_a_policy() {
    let f = Fixture::new(0, 0);

    f.env.set_auths(&[]);
    assert!(f
        .client()
        .try_queue_fee_policy(&100, &0, &Some(f.platform.clone()))
        .is_err());

    f.env.mock_all_auths();
    f.client()
        .queue_fee_policy(&100, &0, &Some(f.platform.clone()));

    f.env.set_auths(&[]);
    assert!(f.client().try_cancel_fee_policy().is_err());

    f.env.mock_all_auths();
    f.client().cancel_fee_policy();
    assert!(f.client().get_pending_fee_policy().is_none());
    let err = f.client().try_cancel_fee_policy().unwrap_err().unwrap();
    assert_eq!(err, Error::NothingQueued);
}

#[test]
fn a_cancelled_policy_never_takes_effect() {
    let f = Fixture::new(0, 0);
    f.client()
        .queue_fee_policy(&900, &100, &Some(f.platform.clone()));
    f.client().cancel_fee_policy();
    f.advance_by(FEE_TIMELOCK_SECONDS * 2);

    let err = f.client().try_execute_fee_policy().unwrap_err().unwrap();
    assert_eq!(err, Error::NothingQueued);
    assert_eq!(f.client().get_fee_policy().platform_fee_bps, 0);
}

// ── Snapshotting ─────────────────────────────────────────────────────────────

#[test]
fn a_later_policy_change_cannot_reach_an_existing_claim() {
    let f = Fixture::new(0, 0); // fee-free at creation time
    let creator = f.user(100 * USDC);
    let c1 = f.user(100 * USDC);

    let id = f.client().create_claim(&creator, &f.params(10 * USDC));
    f.client().challenge_claim(&c1, &id, &(10 * USDC), &None);
    assert_eq!(f.client().get_claim_fees(&id).platform_fee_bps, 0);

    // Owner raises fees to the cap and executes after the timelock.
    f.client()
        .queue_fee_policy(&1_000, &0, &Some(f.platform.clone()));
    f.advance_by(FEE_TIMELOCK_SECONDS);
    f.client().execute_fee_policy();
    assert_eq!(f.client().get_fee_policy().platform_fee_bps, 1_000);
    // The claim's snapshot is untouched.
    assert_eq!(f.client().get_claim_fees(&id).platform_fee_bps, 0);

    f.client().resolve_claim(
        &id,
        &WinnerSide::Creator,
        &f.str("done"),
        &90,
        &f.zero_hash(),
    );

    // Zero fee, exactly as promised when the money was committed.
    assert_eq!(f.client().get_accrued_fees(&f.platform), 0);
    assert_eq!(f.token().balance(&creator), 110 * USDC);
    assert_eq!(f.escrow_balance(), 0);
}

#[test]
fn a_new_claim_picks_up_the_new_policy() {
    let f = Fixture::new(0, 0);
    f.client()
        .queue_fee_policy(&250, &250, &Some(f.platform.clone()));
    f.advance_by(FEE_TIMELOCK_SECONDS);
    f.client().execute_fee_policy();

    let creator = f.user(100 * USDC);
    let id = f.client().create_claim(&creator, &f.params(10 * USDC));
    let snapshot = f.client().get_claim_fees(&id);
    assert_eq!(snapshot.platform_fee_bps, 250);
    assert_eq!(snapshot.agent_owner_fee_bps, 250);
    assert_eq!(snapshot.platform_recipient, Some(f.platform.clone()));
    assert_eq!(snapshot.agent_owner_recipient, None);
}

#[test]
fn a_queued_but_unexecuted_policy_is_not_snapshotted() {
    let f = Fixture::new(100, 0);
    // Queue a higher policy; do not execute. Creation must freeze the LIVE policy.
    f.client()
        .queue_fee_policy(&900, &100, &Some(f.platform.clone()));
    assert!(f.client().get_pending_fee_policy().is_some());

    let creator = f.user(100 * USDC);
    let id = f.client().create_claim(&creator, &f.params(10 * USDC));
    let snapshot = f.client().get_claim_fees(&id);
    assert_eq!(snapshot.platform_fee_bps, 100);
    assert_eq!(snapshot.agent_owner_fee_bps, 0);
    assert_eq!(snapshot.platform_recipient, Some(f.platform.clone()));
}

#[test]
fn changing_the_platform_recipient_cannot_redirect_an_existing_claim() {
    let f = Fixture::new(1_000, 0);
    let creator = f.user(100 * USDC);
    let c1 = f.user(100 * USDC);
    // The fee timelock is two days, so the claim's deadline has to outlive the
    // queue/execute cycle below: the challenge afterwards must still land
    // inside the claim's challenge window.
    let mut params = f.params(10 * USDC);
    params.deadline = f.env.ledger().timestamp() + FEE_TIMELOCK_SECONDS + 3_600;
    let id = f.client().create_claim(&creator, &params);
    assert_eq!(
        f.client().get_claim_fees(&id).platform_recipient,
        Some(f.platform.clone())
    );

    let new_platform = Address::generate(&f.env);
    f.client()
        .queue_fee_policy(&1_000, &0, &Some(new_platform.clone()));
    f.advance_by(FEE_TIMELOCK_SECONDS);
    f.client().execute_fee_policy();
    assert_eq!(
        f.client().get_fee_policy().platform_recipient,
        Some(new_platform.clone())
    );
    // Frozen recipient on the claim is unchanged.
    assert_eq!(
        f.client().get_claim_fees(&id).platform_recipient,
        Some(f.platform.clone())
    );

    f.client().challenge_claim(&c1, &id, &(10 * USDC), &None);
    f.advance_by(3_600);
    f.client().resolve_claim(
        &id,
        &WinnerSide::Creator,
        &f.str("creator"),
        &90,
        &f.zero_hash(),
    );

    // Fees accrued to the snapshotted recipient, not the new live one.
    assert_eq!(f.client().get_accrued_fees(&f.platform), USDC);
    assert_eq!(f.client().get_accrued_fees(&new_platform), 0);
}

// ── Agent attribution ────────────────────────────────────────────────────────

#[test]
fn the_agent_owner_fee_is_paid_to_the_attributed_wallet() {
    let f = Fixture::new(400, 600); // 4% platform + 6% agent = the cap
    let creator = f.user(100 * USDC);
    let c1 = f.user(100 * USDC);
    let agent = Address::generate(&f.env);

    let mut params = f.params(10 * USDC);
    params.agent_owner_recipient = Some(agent.clone());
    let id = f.client().create_claim(&creator, &params);
    assert_eq!(
        f.client().get_claim_fees(&id).agent_owner_recipient,
        Some(agent.clone())
    );

    f.client().challenge_claim(&c1, &id, &(10 * USDC), &None);
    f.advance_by(3_600);
    f.client().resolve_claim(
        &id,
        &WinnerSide::Creator,
        &f.str("creator"),
        &90,
        &f.zero_hash(),
    );

    // Profit 10 USDC → platform 0.4, agent 0.6.
    assert_eq!(f.client().get_accrued_fees(&f.platform), 4 * USDC / 10);
    assert_eq!(f.client().get_accrued_fees(&agent), 6 * USDC / 10);
    assert_eq!(
        f.token().balance(&creator),
        90 * USDC + 20 * USDC - USDC // 10% of 10 USDC profit
    );
}

#[test]
fn without_an_agent_recipient_the_agent_fee_is_not_charged() {
    let f = Fixture::new(400, 600);
    let creator = f.user(100 * USDC);
    let c1 = f.user(100 * USDC);

    let id = f.client().create_claim(&creator, &f.params(10 * USDC));
    f.client().challenge_claim(&c1, &id, &(10 * USDC), &None);
    f.advance_by(3_600);
    f.client().resolve_claim(
        &id,
        &WinnerSide::Creator,
        &f.str("creator"),
        &90,
        &f.zero_hash(),
    );

    // Only the 4% platform slice is taken; the 6% agent slice is not minted to
    // anyone, it stays with the winner.
    assert_eq!(f.client().get_accrued_fees(&f.platform), 4 * USDC / 10);
    assert_eq!(
        f.token().balance(&creator),
        90 * USDC + 20 * USDC - 4 * USDC / 10
    );
}

// ── Fee claiming ─────────────────────────────────────────────────────────────

#[test]
fn fees_are_pulled_not_pushed_and_only_once() {
    let f = Fixture::new(1_000, 0);
    let creator = f.user(100 * USDC);
    let c1 = f.user(100 * USDC);

    let id = f.client().create_claim(&creator, &f.params(10 * USDC));
    f.client().challenge_claim(&c1, &id, &(10 * USDC), &None);
    f.advance_by(3_600);
    f.client().resolve_claim(
        &id,
        &WinnerSide::Creator,
        &f.str("creator"),
        &90,
        &f.zero_hash(),
    );

    let expected = USDC; // 10% of 10 USDC profit
    assert_eq!(f.client().get_accrued_fees(&f.platform), expected);
    assert_eq!(f.token().balance(&f.platform), 0);

    assert_eq!(f.client().claim_fees(&f.platform), expected);
    assert_eq!(f.token().balance(&f.platform), expected);
    assert_eq!(f.client().get_accrued_fees(&f.platform), 0);
    assert_eq!(f.escrow_balance(), 0);

    let stats = f.client().get_platform_stats();
    assert_eq!(stats.fees_accrued, expected);
    assert_eq!(stats.fees_claimed, expected);

    assert_eq!(f.client().claim_fees(&f.platform), 0);
}

#[test]
fn an_unrelated_address_has_no_fees_to_claim() {
    let f = Fixture::new(1_000, 0);
    let stranger = Address::generate(&f.env);
    assert_eq!(f.client().claim_fees(&stranger), 0);
}

// ── Ownership / oracle ───────────────────────────────────────────────────────

#[test]
fn ownership_and_oracle_transfer_are_owner_gated() {
    let f = Fixture::new(0, 0);
    let new_owner = Address::generate(&f.env);
    let new_oracle = Address::generate(&f.env);

    f.env.set_auths(&[]);
    assert!(f.client().try_set_oracle(&new_oracle).is_err());
    assert!(f.client().try_transfer_ownership(&new_owner).is_err());

    f.env.mock_all_auths();
    f.client().set_oracle(&new_oracle);
    assert_eq!(f.client().get_oracle(), new_oracle);

    f.client().transfer_ownership(&new_owner);
    assert_eq!(f.client().get_owner(), new_owner);
}
