#![cfg(test)]
//! Fee rounding favours participants.
//!
//! The squad fee is `floor(profit * fee_bps / BPS_DIVISOR)`, computed by the one
//! `profit_fee` function that both `claim` and `preview_claim` call. It never
//! exceeds the exact share of profit, falls short of it by under one stroop, and
//! the remainder stays with the winner. Proven over exhaustive small profits,
//! random large ones, and randomized markets settled through the public
//! interface, down to single-stroop deposits.

extern crate std;

use crate::pool::profit_fee;
use crate::test_common::{Fixture, DEFAULT_DURATION, USDC};
use crate::types::{BPS_DIVISOR, MAX_FEE_BPS, RESULT_CANCELLED, SIDE_A, SIDE_B};

/// Deterministic xorshift64, so any failure reproduces exactly.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }

    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

/// The properties every fee must satisfy, whatever the inputs.
fn assert_rounds_for_the_participant(principal: i128, profit: i128, bps: u32) {
    let fee = profit_fee(principal, principal + profit, bps).unwrap();
    let exact = profit * bps as i128;
    assert_eq!(fee, exact / BPS_DIVISOR, "profit {profit} at {bps} bps");
    assert!(fee * BPS_DIVISOR <= exact, "profit {profit} at {bps} bps");
    assert!(
        exact - fee * BPS_DIVISOR < BPS_DIVISOR,
        "profit {profit} at {bps} bps"
    );
    assert!(fee * BPS_DIVISOR <= profit * MAX_FEE_BPS as i128);
    assert!(principal + profit - fee >= principal);
}

// ── The fee function ─────────────────────────────────────────────────────────

#[test]
fn the_fee_is_the_floor_of_its_exact_share_for_small_profits() {
    for bps in [0, 1, 7, 50, 333, 999, MAX_FEE_BPS] {
        for profit in 0..=25_000i128 {
            assert_rounds_for_the_participant(10 * USDC, profit, bps);
        }
    }
}

#[test]
fn the_fee_is_the_floor_of_its_exact_share_for_random_amounts() {
    let mut rng = Rng(0x2545_F491_4F6C_DD1D);
    for _ in 0..50_000 {
        let bps = rng.below(MAX_FEE_BPS as u64 + 1) as u32;
        let principal = (rng.next() >> 1) as i128;
        let profit = (rng.next() >> (1 + rng.below(63))) as i128;
        assert_rounds_for_the_participant(principal, profit, bps);
    }
}

/// A fee rounds to zero until profit reaches `ceil(BPS_DIVISOR / bps)`.
#[test]
fn the_fee_is_zero_until_profit_buys_a_whole_stroop() {
    for (bps, threshold) in [(1u32, 10_000i128), (7, 1_429), (333, 31), (MAX_FEE_BPS, 10)] {
        assert_eq!(profit_fee(0, threshold - 1, bps).unwrap(), 0, "{bps} bps");
        assert_eq!(profit_fee(0, threshold, bps).unwrap(), 1, "{bps} bps");
    }
}

#[test]
fn no_profit_means_no_fee() {
    for gross in [0, 1, 10 * USDC - 1, 10 * USDC] {
        assert_eq!(profit_fee(10 * USDC, gross, MAX_FEE_BPS).unwrap(), 0);
    }
}

// ── End to end through the contract ──────────────────────────────────────────

/// A lone winner's profit of 10 USDC + 19 stroops at 10% owes 10,000,001.9
/// stroops; the contract takes 10,000,001 and the winner keeps the 0.9.
#[test]
fn a_winner_keeps_the_rounding_remainder_end_to_end() {
    let f = Fixture::new();
    let captain = f.user(0);
    let a1 = f.user(10 * USDC);
    let b1 = f.user(10 * USDC + 19);
    let id = f.market(&captain, MAX_FEE_BPS);

    f.client().deposit(&a1, &id, &SIDE_A, &(10 * USDC));
    f.client().deposit(&b1, &id, &SIDE_B, &(10 * USDC + 19));
    f.advance_by(DEFAULT_DURATION);
    f.client().resolve(&id, &SIDE_A);

    let preview = f.client().preview_claim(&id, &SIDE_A, &a1);
    assert_eq!((preview.gross, preview.fee), (20 * USDC + 19, 10_000_001));
    let net = f.client().claim(&a1, &id, &SIDE_A);
    assert_eq!(net, 20 * USDC + 19 - 10_000_001);
    assert_eq!(net, preview.net);
    assert_eq!(f.client().get_accrued_fees(), 10_000_001);
    assert_eq!(f.escrow_balance(), 10_000_001);
}

/// Randomized markets, with deposits from a single stroop up to hundreds of
/// USDC: every winner's fee is the floor of profit times the market's bps, the
/// preview matches the payout, no winner loses principal, and the escrow holds
/// exactly the accrued fees at the end.
#[test]
fn randomized_markets_never_round_a_fee_toward_the_protocol() {
    let mut rng = Rng(0x94D0_49BB_1331_11EB);

    for round in 0..48 {
        let f = Fixture::new();
        let captain = f.user(0);
        let fee_bps = rng.below(MAX_FEE_BPS as u64 + 1) as u32;
        let id = f.market(&captain, fee_bps);

        let mut deposits = std::vec::Vec::new();
        for side in [SIDE_A, SIDE_B] {
            for _ in 0..1 + rng.below(4) {
                // Mix dust-sized and large deposits so truncation is exercised
                // at both ends.
                let amount = if rng.below(3) == 0 {
                    1 + rng.below(1_000) as i128
                } else {
                    1 + rng.below(500 * USDC as u64) as i128
                };
                let who = f.user(amount);
                f.client().deposit(&who, &id, &side, &amount);
                deposits.push((who, side, amount));
            }
        }
        let pot = f.escrow_balance();

        let result = [SIDE_A, SIDE_B, RESULT_CANCELLED][rng.below(3) as usize];
        f.advance_by(DEFAULT_DURATION);
        f.client().resolve(&id, &result);

        let mut paid = 0;
        for (who, side, principal) in deposits.iter() {
            if result != RESULT_CANCELLED && *side != result {
                continue;
            }
            let fees_before = f.client().get_accrued_fees();
            let preview = f.client().preview_claim(&id, side, who);
            let net = f.client().claim(who, &id, side);
            let fee = f.client().get_accrued_fees() - fees_before;

            let profit = if preview.gross > *principal {
                preview.gross - principal
            } else {
                0
            };
            let expected = if result == RESULT_CANCELLED {
                0
            } else {
                profit * fee_bps as i128 / BPS_DIVISOR
            };
            assert_eq!(fee, expected, "round {round}: fee");
            assert_eq!(preview.fee, fee, "round {round}: preview fee");
            assert_eq!(net, preview.net, "round {round}: preview vs payout");
            assert_eq!(net, preview.gross - fee, "round {round}");
            assert!(net >= *principal, "round {round}: principal lost");
            paid += net;
        }

        let fees = f.client().get_accrued_fees();
        assert_eq!(paid + fees, pot, "round {round}: conservation");
        assert_eq!(f.escrow_balance(), fees, "round {round}: escrow");
    }
}
