#![cfg(test)]
//! Market creation, deposits, pre-deadline withdrawal and resolution gating.

extern crate std;

use soroban_sdk::testutils::Address as _;
use soroban_sdk::Address;

use crate::test_common::{Fixture, DEFAULT_DURATION, USDC};
use crate::types::{
    Error, MAX_DURATION, MAX_FEE_BPS, MAX_PARTICIPANTS_PER_SIDE, MIN_DURATION, RESULT_CANCELLED,
    SIDE_A, SIDE_B,
};

// ── Creation ─────────────────────────────────────────────────────────────────

#[test]
fn creating_a_market_records_the_captain_and_terms() {
    let f = Fixture::new();
    let captain = f.user(0);
    let id = f.market(&captain, 250);
    assert_eq!(id, 1);

    let m = f.client().get_market(&id);
    assert_eq!(m.captain, captain);
    assert_eq!(m.deadline, f.now() + DEFAULT_DURATION);
    assert_eq!(m.fee_bps, 250);
    assert!(!m.resolved);
    assert_eq!(m.result, 0);
    assert_eq!(m.pool_a, 0);
    assert_eq!(m.pool_b, 0);
    assert_eq!(m.remaining_escrow, 0);
    assert_eq!(m.participants_a, 0);
    assert_eq!(m.participants_b, 0);
    assert_eq!(m.winner_claims, 0);
    assert_eq!(f.client().get_market_count(), 1);
}

#[test]
fn market_ids_increment() {
    let f = Fixture::new();
    let captain = f.user(0);
    assert_eq!(f.market(&captain, 0), 1);
    assert_eq!(f.market(&captain, 0), 2);
    assert_eq!(f.client().get_market_count(), 2);
}

#[test]
fn an_empty_question_is_rejected() {
    let f = Fixture::new();
    let captain = f.user(0);
    let err = f
        .client()
        .try_create_market(&captain, &f.str(""), &(f.now() + DEFAULT_DURATION), &0)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::EmptyQuestion);
}

#[test]
fn the_deadline_must_sit_inside_the_duration_window() {
    let f = Fixture::new();
    let captain = f.user(0);
    let now = f.now();

    // Too soon.
    let err = f
        .client()
        .try_create_market(&captain, &f.str("q"), &(now + MIN_DURATION - 1), &0)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::BadDeadline);

    // Too far out.
    let err = f
        .client()
        .try_create_market(&captain, &f.str("q"), &(now + MAX_DURATION + 1), &0)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::BadDeadline);

    // A deadline in the past.
    let err = f
        .client()
        .try_create_market(&captain, &f.str("q"), &(now - 1), &0)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::BadDeadline);

    // Both boundaries are inclusive.
    f.client()
        .create_market(&captain, &f.str("q"), &(now + MIN_DURATION), &0);
    f.client()
        .create_market(&captain, &f.str("q"), &(now + MAX_DURATION), &0);
}

#[test]
fn the_fee_cap_is_enforced_at_creation() {
    let f = Fixture::new();
    let captain = f.user(0);
    let err = f
        .client()
        .try_create_market(
            &captain,
            &f.str("q"),
            &(f.now() + DEFAULT_DURATION),
            &(MAX_FEE_BPS + 1),
        )
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::FeeCapExceeded);

    // Exactly at the cap is accepted.
    let id = f.market(&captain, MAX_FEE_BPS);
    assert_eq!(f.client().get_market(&id).fee_bps, MAX_FEE_BPS);
}

#[test]
fn creating_a_market_requires_the_captains_signature() {
    let f = Fixture::new();
    let captain = f.user(0);
    f.env.set_auths(&[]);
    assert!(f
        .client()
        .try_create_market(&captain, &f.str("q"), &(f.now() + DEFAULT_DURATION), &0)
        .is_err());
}

#[test]
fn initialize_is_one_shot() {
    let f = Fixture::new();
    let err = f
        .client()
        .try_initialize(&f.token_id, &f.oracle, &f.fee_recipient)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::AlreadyInitialized);
}

// ── Deposits ─────────────────────────────────────────────────────────────────

#[test]
fn depositing_moves_usdc_into_escrow_and_credits_shares() {
    let f = Fixture::new();
    let captain = f.user(0);
    let a1 = f.user(100 * USDC);
    let b1 = f.user(100 * USDC);
    let id = f.market(&captain, 0);

    f.client().deposit(&a1, &id, &SIDE_A, &(10 * USDC));
    f.client().deposit(&b1, &id, &SIDE_B, &(30 * USDC));

    assert_eq!(f.token().balance(&a1), 90 * USDC);
    assert_eq!(f.token().balance(&b1), 70 * USDC);
    assert_eq!(f.escrow_balance(), 40 * USDC);

    let m = f.client().get_market(&id);
    assert_eq!(m.pool_a, 10 * USDC);
    assert_eq!(m.pool_b, 30 * USDC);
    assert_eq!(m.participants_a, 1);
    assert_eq!(m.participants_b, 1);
    // Shares equal deposited units.
    assert_eq!(f.client().get_deposit(&id, &SIDE_A, &a1), 10 * USDC);
    assert_eq!(f.client().get_deposit(&id, &SIDE_B, &b1), 30 * USDC);
    assert_eq!(f.client().get_deposit(&id, &SIDE_B, &a1), 0);
}

#[test]
fn topping_up_does_not_consume_a_second_participant_slot() {
    let f = Fixture::new();
    let captain = f.user(0);
    let a1 = f.user(100 * USDC);
    let id = f.market(&captain, 0);

    f.client().deposit(&a1, &id, &SIDE_A, &(5 * USDC));
    f.client().deposit(&a1, &id, &SIDE_A, &(7 * USDC));

    let m = f.client().get_market(&id);
    assert_eq!(m.participants_a, 1);
    assert_eq!(m.pool_a, 12 * USDC);
    assert_eq!(f.client().get_deposit(&id, &SIDE_A, &a1), 12 * USDC);
}

#[test]
fn the_same_address_can_hold_a_position_on_both_sides() {
    let f = Fixture::new();
    let captain = f.user(0);
    let both = f.user(100 * USDC);
    let id = f.market(&captain, 0);

    f.client().deposit(&both, &id, &SIDE_A, &(4 * USDC));
    f.client().deposit(&both, &id, &SIDE_B, &(6 * USDC));

    let m = f.client().get_market(&id);
    assert_eq!(m.participants_a, 1);
    assert_eq!(m.participants_b, 1);
    assert_eq!(f.client().get_deposit(&id, &SIDE_A, &both), 4 * USDC);
    assert_eq!(f.client().get_deposit(&id, &SIDE_B, &both), 6 * USDC);
}

#[test]
fn a_bad_side_or_amount_is_rejected() {
    let f = Fixture::new();
    let captain = f.user(0);
    let a1 = f.user(100 * USDC);
    let id = f.market(&captain, 0);

    for bad_side in [0u32, 3, 4, 99] {
        let err = f
            .client()
            .try_deposit(&a1, &id, &bad_side, &(5 * USDC))
            .unwrap_err()
            .unwrap();
        assert_eq!(err, Error::BadSide);
    }
    for bad_amount in [0i128, -1, -5 * USDC] {
        let err = f
            .client()
            .try_deposit(&a1, &id, &SIDE_A, &bad_amount)
            .unwrap_err()
            .unwrap();
        assert_eq!(err, Error::ZeroAmount);
    }
    assert_eq!(f.escrow_balance(), 0);
}

#[test]
fn deposits_close_at_the_deadline() {
    let f = Fixture::new();
    let captain = f.user(0);
    let a1 = f.user(100 * USDC);
    let id = f.market(&captain, 0);

    f.advance_by(DEFAULT_DURATION - 1);
    f.client().deposit(&a1, &id, &SIDE_A, &(5 * USDC));

    // Exactly at the deadline the market is closed.
    f.advance_by(1);
    let b1 = f.user(100 * USDC);
    let err = f
        .client()
        .try_deposit(&b1, &id, &SIDE_B, &(5 * USDC))
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::MarketClosed);
}

#[test]
fn depositing_into_an_unknown_market_is_rejected() {
    let f = Fixture::new();
    let a1 = f.user(100 * USDC);
    let err = f
        .client()
        .try_deposit(&a1, &42, &SIDE_A, &(5 * USDC))
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::MarketNotFound);
}

#[test]
fn depositing_requires_the_participants_signature() {
    let f = Fixture::new();
    let captain = f.user(0);
    let a1 = f.user(100 * USDC);
    let id = f.market(&captain, 0);

    f.env.set_auths(&[]);
    assert!(f.client().try_deposit(&a1, &id, &SIDE_A, &(5 * USDC)).is_err());
}

#[test]
fn each_side_enforces_the_participant_cap_independently() {
    let f = Fixture::new();
    f.env.cost_estimate().budget().reset_unlimited();
    let captain = f.user(0);
    let id = f.market(&captain, 0);

    let mut side_a = std::vec::Vec::new();
    for _ in 0..MAX_PARTICIPANTS_PER_SIDE {
        let who = f.user(USDC);
        f.client().deposit(&who, &id, &SIDE_A, &USDC);
        side_a.push(who);
    }
    assert_eq!(
        f.client().get_market(&id).participants_a,
        MAX_PARTICIPANTS_PER_SIDE
    );

    // Side A is full...
    let overflow = f.user(USDC);
    let err = f
        .client()
        .try_deposit(&overflow, &id, &SIDE_A, &USDC)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::SideFull);

    // ...but an existing side-A depositor can still top up.
    f.mint(&side_a[0], USDC);
    f.client().deposit(&side_a[0], &id, &SIDE_A, &USDC);
    assert_eq!(f.client().get_deposit(&id, &SIDE_A, &side_a[0]), 2 * USDC);

    // ...and side B is untouched.
    f.client().deposit(&overflow, &id, &SIDE_B, &USDC);
    assert_eq!(f.client().get_market(&id).participants_b, 1);
}

#[test]
fn a_freed_slot_can_be_reused() {
    let f = Fixture::new();
    let captain = f.user(0);
    let id = f.market(&captain, 0);

    // Fill side A to the cap with a small helper cap for speed by using
    // withdrawal to free a slot instead of 200 depositors.
    let a1 = f.user(10 * USDC);
    f.client().deposit(&a1, &id, &SIDE_A, &(5 * USDC));
    assert_eq!(f.client().get_market(&id).participants_a, 1);

    // Full withdrawal frees the slot.
    f.client()
        .withdraw_before_deadline(&a1, &id, &SIDE_A, &(5 * USDC));
    assert_eq!(f.client().get_market(&id).participants_a, 0);

    // Depositing again takes a fresh slot.
    f.client().deposit(&a1, &id, &SIDE_A, &(5 * USDC));
    assert_eq!(f.client().get_market(&id).participants_a, 1);
}

// ── Withdraw before deadline ─────────────────────────────────────────────────

#[test]
fn a_partial_withdrawal_updates_the_pool_and_keeps_the_slot() {
    let f = Fixture::new();
    let captain = f.user(0);
    let a1 = f.user(100 * USDC);
    let id = f.market(&captain, 0);

    f.client().deposit(&a1, &id, &SIDE_A, &(10 * USDC));
    f.client()
        .withdraw_before_deadline(&a1, &id, &SIDE_A, &(4 * USDC));

    let m = f.client().get_market(&id);
    assert_eq!(m.pool_a, 6 * USDC);
    // The position is still open, so the slot is still held.
    assert_eq!(m.participants_a, 1);
    assert_eq!(f.client().get_deposit(&id, &SIDE_A, &a1), 6 * USDC);
    assert_eq!(f.token().balance(&a1), 94 * USDC);
    assert_eq!(f.escrow_balance(), 6 * USDC);
}

#[test]
fn a_full_withdrawal_releases_the_slot() {
    let f = Fixture::new();
    let captain = f.user(0);
    let a1 = f.user(100 * USDC);
    let b1 = f.user(100 * USDC);
    let id = f.market(&captain, 0);

    f.client().deposit(&a1, &id, &SIDE_A, &(10 * USDC));
    f.client().deposit(&b1, &id, &SIDE_B, &(10 * USDC));
    f.client()
        .withdraw_before_deadline(&a1, &id, &SIDE_A, &(10 * USDC));

    let m = f.client().get_market(&id);
    assert_eq!(m.pool_a, 0);
    assert_eq!(m.participants_a, 0);
    // Side B is untouched.
    assert_eq!(m.pool_b, 10 * USDC);
    assert_eq!(m.participants_b, 1);
    assert_eq!(f.client().get_deposit(&id, &SIDE_A, &a1), 0);
    assert_eq!(f.token().balance(&a1), 100 * USDC);
    assert_eq!(f.escrow_balance(), 10 * USDC);
}

#[test]
fn withdrawing_more_than_the_balance_is_rejected() {
    let f = Fixture::new();
    let captain = f.user(0);
    let a1 = f.user(100 * USDC);
    let id = f.market(&captain, 0);
    f.client().deposit(&a1, &id, &SIDE_A, &(10 * USDC));

    for bad in [10 * USDC + 1, 100 * USDC, 0, -1] {
        let err = f
            .client()
            .try_withdraw_before_deadline(&a1, &id, &SIDE_A, &bad)
            .unwrap_err()
            .unwrap();
        assert_eq!(err, Error::BadAmount);
    }
    // Nothing moved.
    assert_eq!(f.escrow_balance(), 10 * USDC);
    assert_eq!(f.client().get_deposit(&id, &SIDE_A, &a1), 10 * USDC);
}

#[test]
fn withdrawing_from_the_wrong_side_is_rejected() {
    let f = Fixture::new();
    let captain = f.user(0);
    let a1 = f.user(100 * USDC);
    let id = f.market(&captain, 0);
    f.client().deposit(&a1, &id, &SIDE_A, &(10 * USDC));

    // No balance on side B, so it returns Ok(()) idempotently.
    f.client().withdraw_before_deadline(&a1, &id, &SIDE_B, &(1 * USDC));

    // And an out-of-range side is refused outright.
    let err = f
        .client()
        .try_withdraw_before_deadline(&a1, &id, &7, &(1 * USDC))
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::BadSide);
}

#[test]
fn withdrawal_locks_at_the_deadline_and_after_resolution() {
    let f = Fixture::new();
    let captain = f.user(0);
    let a1 = f.user(100 * USDC);
    let b1 = f.user(100 * USDC);
    let id = f.market(&captain, 0);
    f.client().deposit(&a1, &id, &SIDE_A, &(10 * USDC));
    f.client().deposit(&b1, &id, &SIDE_B, &(10 * USDC));

    f.advance_by(DEFAULT_DURATION);
    let err = f
        .client()
        .try_withdraw_before_deadline(&a1, &id, &SIDE_A, &(1 * USDC))
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::Locked);

    f.client().resolve(&id, &SIDE_A);
    let err = f
        .client()
        .try_withdraw_before_deadline(&a1, &id, &SIDE_A, &(1 * USDC))
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::Locked);
}

#[test]
fn withdrawing_requires_the_participants_signature() {
    let f = Fixture::new();
    let captain = f.user(0);
    let a1 = f.user(100 * USDC);
    let id = f.market(&captain, 0);
    f.client().deposit(&a1, &id, &SIDE_A, &(10 * USDC));

    f.env.set_auths(&[]);
    assert!(f
        .client()
        .try_withdraw_before_deadline(&a1, &id, &SIDE_A, &(1 * USDC))
        .is_err());
}

// ── Resolution ───────────────────────────────────────────────────────────────

#[test]
fn resolution_sets_the_result_and_freezes_the_escrow_total() {
    let f = Fixture::new();
    let captain = f.user(0);
    let a1 = f.user(100 * USDC);
    let b1 = f.user(100 * USDC);
    let id = f.market(&captain, 0);
    f.client().deposit(&a1, &id, &SIDE_A, &(10 * USDC));
    f.client().deposit(&b1, &id, &SIDE_B, &(30 * USDC));

    f.advance_by(DEFAULT_DURATION);
    f.client().resolve(&id, &SIDE_A);

    let m = f.client().get_market(&id);
    assert!(m.resolved);
    assert_eq!(m.result, SIDE_A);
    assert_eq!(m.remaining_escrow, 40 * USDC);
}

#[test]
fn resolving_before_the_deadline_is_rejected() {
    let f = Fixture::new();
    let captain = f.user(0);
    let a1 = f.user(100 * USDC);
    let id = f.market(&captain, 0);
    f.client().deposit(&a1, &id, &SIDE_A, &(10 * USDC));

    let err = f.client().try_resolve(&id, &SIDE_A).unwrap_err().unwrap();
    assert_eq!(err, Error::NotResolvable);
}

#[test]
fn only_the_oracle_can_resolve() {
    let f = Fixture::new();
    let captain = f.user(0);
    let a1 = f.user(100 * USDC);
    let id = f.market(&captain, 0);
    f.client().deposit(&a1, &id, &SIDE_A, &(10 * USDC));
    f.advance_by(DEFAULT_DURATION);

    f.env.set_auths(&[]);
    assert!(f.client().try_resolve(&id, &SIDE_A).is_err());

    f.env.mock_all_auths();
    f.client().resolve(&id, &SIDE_A);
    assert!(f.client().get_market(&id).resolved);
}

#[test]
fn resolving_twice_with_same_inputs_is_idempotent() {
    let f = Fixture::new();
    let captain = f.user(0);
    let a1 = f.user(100 * USDC);
    let id = f.market(&captain, 0);
    f.client().deposit(&a1, &id, &SIDE_A, &(10 * USDC));
    f.advance_by(DEFAULT_DURATION);

    f.client().resolve(&id, &SIDE_A);
    f.client().resolve(&id, &SIDE_A); // Should not error

    let m = f.client().get_market(&id);
    assert!(m.resolved);
    assert_eq!(m.result, SIDE_A);
}

#[test]
fn resolving_twice_with_different_inputs_is_rejected() {
    let f = Fixture::new();
    let captain = f.user(0);
    let a1 = f.user(100 * USDC);
    let id = f.market(&captain, 0);
    f.client().deposit(&a1, &id, &SIDE_A, &(10 * USDC));
    f.advance_by(DEFAULT_DURATION);

    f.client().resolve(&id, &SIDE_A);
    let err = f.client().try_resolve(&id, &SIDE_B).unwrap_err().unwrap();
    assert_eq!(err, Error::NotResolvable);
}

#[test]
fn an_out_of_range_result_is_rejected() {
    let f = Fixture::new();
    let captain = f.user(0);
    let a1 = f.user(100 * USDC);
    let id = f.market(&captain, 0);
    f.client().deposit(&a1, &id, &SIDE_A, &(10 * USDC));
    f.advance_by(DEFAULT_DURATION);

    for bad in [0u32, 4, 99] {
        let err = f.client().try_resolve(&id, &bad).unwrap_err().unwrap();
        assert_eq!(err, Error::BadResult);
    }
}

#[test]
fn a_winning_side_with_an_empty_pool_cannot_be_declared() {
    let f = Fixture::new();
    let captain = f.user(0);
    let a1 = f.user(100 * USDC);
    let id = f.market(&captain, 0);
    f.client().deposit(&a1, &id, &SIDE_A, &(10 * USDC));
    f.advance_by(DEFAULT_DURATION);

    // Nobody backed side B.
    let err = f.client().try_resolve(&id, &SIDE_B).unwrap_err().unwrap();
    assert_eq!(err, Error::EmptyWinner);

    // Cancelling a one-sided market is still allowed.
    f.client().resolve(&id, &RESULT_CANCELLED);
    assert_eq!(f.client().get_market(&id).result, RESULT_CANCELLED);
}

#[test]
fn an_entirely_empty_market_can_only_be_cancelled() {
    let f = Fixture::new();
    let captain = f.user(0);
    let id = f.market(&captain, 0);
    f.advance_by(DEFAULT_DURATION);

    assert_eq!(
        f.client().try_resolve(&id, &SIDE_A).unwrap_err().unwrap(),
        Error::EmptyWinner
    );
    f.client().resolve(&id, &RESULT_CANCELLED);
    assert_eq!(f.client().get_market(&id).remaining_escrow, 0);
}

#[test]
fn resolving_an_unknown_market_is_rejected() {
    let f = Fixture::new();
    let err = f.client().try_resolve(&42, &SIDE_A).unwrap_err().unwrap();
    assert_eq!(err, Error::MarketNotFound);
}

// ── Views ────────────────────────────────────────────────────────────────────

#[test]
fn views_report_the_wired_configuration() {
    let f = Fixture::new();
    assert_eq!(f.client().get_usdc(), f.token_id);
    assert_eq!(f.client().get_oracle(), f.oracle);
    assert_eq!(f.client().get_fee_recipient(), f.fee_recipient);
    assert_eq!(f.client().get_market_count(), 0);
    assert_eq!(f.client().get_accrued_fees(), 0);
    assert_eq!(f.client().get_escrow_balance(), 0);
}

#[test]
fn an_unknown_market_reads_as_not_found() {
    let f = Fixture::new();
    assert_eq!(
        f.client().try_get_market(&9).unwrap_err().unwrap(),
        Error::MarketNotFound
    );
    let stranger = Address::generate(&f.env);
    assert_eq!(f.client().get_deposit(&9, &SIDE_A, &stranger), 0);
    assert!(!f.client().has_claimed(&9, &SIDE_A, &stranger));
}


#[test]
fn transition_deadline_works_for_underfunded() {
    let f = Fixture::new();
    let captain = f.user(0);
    let a1 = f.user(100 * USDC);
    let id = f.market(&captain, 0);
    f.client().deposit(&a1, &id, &SIDE_A, &(10 * USDC));

    // Too early
    let err = f.client().try_transition_deadline(&id).unwrap_err().unwrap();
    assert_eq!(err, Error::Locked);

    f.advance_by(DEFAULT_DURATION);
    
    // Now past deadline. Only SIDE_A is funded. Should transition to Cancelled.
    f.client().transition_deadline(&id);
    let m = f.client().get_market(&id);
    assert!(m.resolved);
    assert_eq!(m.result, RESULT_CANCELLED);
    
    // Refund
    f.client().claim(&a1, &id, &SIDE_A);
    assert_eq!(f.token().balance(&a1), 100 * USDC);
}

#[test]
fn transition_deadline_preserves_active_state_to_extend_ttl() {
    let f = Fixture::new();
    let captain = f.user(0);
    let a1 = f.user(100 * USDC);
    let b1 = f.user(100 * USDC);
    let id = f.market(&captain, 0);
    f.client().deposit(&a1, &id, &SIDE_A, &(10 * USDC));
    f.client().deposit(&b1, &id, &SIDE_B, &(10 * USDC));

    f.advance_by(DEFAULT_DURATION);
    
    // Both sides funded, should succeed to persist TTL bumps without resolving
    f.client().transition_deadline(&id);
    let m = f.client().get_market(&id);
    assert!(!m.resolved);
}
