#![cfg(test)]
//! Fee rounding favours participants.
//!
//! Every fee leg is `floor(profit * bps / BPS_DIVISOR)`: it never exceeds its
//! exact share of profit, it falls short of it by less than one stroop, and the
//! fractional remainder stays with the participant. Proven over exhaustive small
//! profits, random large ones, and randomized markets settled end to end through
//! the public interface.

extern crate std;

use soroban_sdk::testutils::Address as _;
use soroban_sdk::{Address, Env, String};

use crate::fees::quote_fees;
use crate::test_common::{Fixture, USDC};
use crate::types::{FeeSnapshot, WinnerSide, BPS_DIVISOR, MAX_TOTAL_FEE_BPS, MIN_STAKE};

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

/// Platform/agent-owner splits: zero, single-bps, lopsided, the live 50/50, and
/// the 10% cap in several shapes.
const LEG_PAIRS: [(u32, u32); 12] = [
    (0, 0),
    (1, 0),
    (0, 1),
    (1, 1),
    (50, 50),
    (700, 300),
    (333, 667),
    (999, 1),
    (1, 999),
    (1_000, 0),
    (0, 1_000),
    (500, 499),
];

fn snapshot(env: &Env, platform_bps: u32, owner_bps: u32, owner: bool) -> FeeSnapshot {
    FeeSnapshot {
        platform_fee_bps: platform_bps,
        agent_owner_fee_bps: owner_bps,
        platform_recipient: Some(Address::generate(env)),
        agent_owner_recipient: if owner {
            Some(Address::generate(env))
        } else {
            None
        },
    }
}

/// The properties every quote must satisfy, whatever the inputs.
fn assert_rounds_for_the_participant(
    principal: i128,
    profit: i128,
    p: u32,
    o: u32,
    snap: &FeeSnapshot,
) {
    let gross = principal + profit;
    let (owed, fee) = quote_fees(principal, gross, snap).unwrap();
    let exact_p = profit * p as i128;
    let exact_o = profit * o as i128;

    // Each leg is exactly the floor of its share.
    assert_eq!(
        fee,
        exact_p / BPS_DIVISOR + exact_o / BPS_DIVISOR,
        "profit {profit} at {p}/{o}"
    );
    // Never more than the exact rational fee...
    assert!(
        fee * BPS_DIVISOR <= exact_p + exact_o,
        "profit {profit} at {p}/{o}"
    );
    // ...and short of it by under one stroop per leg.
    assert!(
        exact_p + exact_o - fee * BPS_DIVISOR < 2 * BPS_DIVISOR,
        "profit {profit} at {p}/{o}"
    );
    // Two legs never take more than one leg at the combined rate.
    assert!(fee <= profit * (p + o) as i128 / BPS_DIVISOR);
    // The remainder is the participant's, and principal is untouched.
    assert_eq!(owed, gross - fee);
    assert!(owed >= principal);
    // The cap binds on the result, not just on the policy.
    assert!(fee * BPS_DIVISOR <= profit * MAX_TOTAL_FEE_BPS as i128);
}

// ── The pure fee function ────────────────────────────────────────────────────

/// Every profit from 0 to 25,000 stroops, where truncation is proportionally
/// largest, for every leg pair.
#[test]
fn every_fee_leg_is_the_floor_of_its_exact_share_for_small_profits() {
    let env = Env::default();
    for (p, o) in LEG_PAIRS {
        let snap = snapshot(&env, p, o, true);
        for profit in 0..=25_000i128 {
            assert_rounds_for_the_participant(MIN_STAKE, profit, p, o, &snap);
        }
    }
}

/// Random principals and profits up to i64::MAX, and random leg pairs under the
/// cap.
#[test]
fn every_fee_leg_is_the_floor_of_its_exact_share_for_random_amounts() {
    let env = Env::default();
    let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
    for _ in 0..200 {
        let p = rng.below(MAX_TOTAL_FEE_BPS as u64 + 1) as u32;
        let o = rng.below((MAX_TOTAL_FEE_BPS - p) as u64 + 1) as u32;
        let snap = snapshot(&env, p, o, true);
        for _ in 0..250 {
            let principal = (rng.next() >> 1) as i128;
            let profit = (rng.next() >> (1 + rng.below(63))) as i128;
            assert_rounds_for_the_participant(principal, profit, p, o, &snap);
        }
    }
}

/// Flooring each leg separately can only leave the participant better off than
/// flooring the combined rate, and here it is strictly better: 2,013 stroops of
/// profit at 7% + 3% is 140 + 60 = 200, where one 10% leg would take 201.
#[test]
fn splitting_the_fee_into_two_legs_never_costs_the_participant() {
    let env = Env::default();
    let snap = snapshot(&env, 700, 300, true);
    let (owed, fee) = quote_fees(MIN_STAKE, MIN_STAKE + 2_013, &snap).unwrap();
    assert_eq!(fee, 140 + 60);
    assert_eq!(2_013 * 1_000 / BPS_DIVISOR, 201);
    assert_eq!(owed, MIN_STAKE + 2_013 - 200);
}

/// A leg rounds to zero until profit reaches `ceil(BPS_DIVISOR / bps)`.
#[test]
fn a_leg_charges_nothing_until_profit_buys_a_whole_stroop() {
    let env = Env::default();
    for (bps, threshold) in [
        (1u32, 10_000i128),
        (50, 200),
        (300, 34),
        (700, 15),
        (1_000, 10),
    ] {
        let snap = snapshot(&env, bps, 0, false);
        let fee_at = |profit: i128| quote_fees(MIN_STAKE, MIN_STAKE + profit, &snap).unwrap().1;
        assert_eq!(fee_at(threshold - 1), 0, "{bps} bps");
        assert_eq!(fee_at(threshold), 1, "{bps} bps");
    }
}

#[test]
fn no_profit_means_no_fee() {
    let env = Env::default();
    for (p, o) in LEG_PAIRS {
        let snap = snapshot(&env, p, o, true);
        for gross in [0, 1, MIN_STAKE - 1, MIN_STAKE] {
            assert_eq!(quote_fees(MIN_STAKE, gross, &snap).unwrap(), (gross, 0));
        }
    }
}

#[test]
fn a_leg_without_a_recipient_is_never_charged() {
    let env = Env::default();
    let profit = 123_456_789i128;

    let no_owner = snapshot(&env, 700, 300, false);
    let (_, fee) = quote_fees(MIN_STAKE, MIN_STAKE + profit, &no_owner).unwrap();
    assert_eq!(fee, profit * 700 / BPS_DIVISOR);

    let nobody = FeeSnapshot {
        platform_recipient: None,
        ..no_owner
    };
    assert_eq!(
        quote_fees(MIN_STAKE, MIN_STAKE + profit, &nobody).unwrap(),
        (MIN_STAKE + profit, 0)
    );
}

// ── End to end through the contract ──────────────────────────────────────────

/// The 2,013-stroop example through the real payout path: a 1.0001x fixed-odds
/// challenger wins, pays 140 + 60 rather than the exact 201.3, and the escrow
/// keeps exactly the accrued fees and nothing else.
#[test]
fn a_winner_keeps_the_rounding_remainder_end_to_end() {
    let f = Fixture::new(700, 300);
    let agent = f.user(0);
    let creator = f.user(100 * USDC);
    let mut params = f.params(10 * USDC);
    params.odds_mode = String::from_str(&f.env, "fixed");
    params.challenger_payout_bps = 10_001;
    params.agent_owner_recipient = Some(agent.clone());
    let id = f.client().create_claim(&creator, &params);

    let stake = 20_130_000; // floor(stake * 1.0001) - stake = 2,013
    let challenger = f.user(stake);
    f.client().challenge_claim(&challenger, &id, &stake, &None);

    f.advance_by(3_600);
    f.client().resolve_claim(
        &id,
        &WinnerSide::Challengers,
        &f.str("yes"),
        &90,
        &f.zero_hash(),
    );

    let quote = f.client().quote_challenger_payout(&id, &challenger);
    assert_eq!((quote.gross, quote.fee), (stake + 2_013, 200));
    let net = f.client().claim_challenger_payout(&challenger, &id);
    assert_eq!(net, stake + 2_013 - 200);
    assert_eq!(net, quote.net);

    assert_eq!(f.client().get_accrued_fees(&f.platform), 140);
    assert_eq!(f.client().get_accrued_fees(&agent), 60);
    assert_eq!(f.token().balance(&creator), 100 * USDC - 2_013);
    assert_eq!(f.escrow_balance(), 200);
}

/// Randomized markets settled through the public interface: every claim's fee
/// legs are the floor of profit times their bps, a leg with no recipient is never
/// charged, quotes match payouts, winners keep their principal, and the escrow
/// holds exactly the accrued fees at the end.
#[test]
fn randomized_markets_never_round_a_fee_toward_the_protocol() {
    let mut rng = Rng(0xD1B5_4A32_D192_ED03);
    let verdicts = [
        WinnerSide::Creator,
        WinnerSide::Challengers,
        WinnerSide::Draw,
        WinnerSide::Unresolvable,
    ];

    for round in 0..48 {
        let p = rng.below(MAX_TOTAL_FEE_BPS as u64 + 1) as u32;
        let o = rng.below((MAX_TOTAL_FEE_BPS - p) as u64 + 1) as u32;
        let f = Fixture::new(p, o);
        let attributed = rng.below(2) == 0;
        let agent = f.user(0);
        let fixed = rng.below(2) == 0;
        let verdict = verdicts[rng.below(4) as usize];

        let creator_stake = MIN_STAKE + rng.below(50 * USDC as u64) as i128;
        let creator = f.user(creator_stake);
        let mut params = f.params(creator_stake);
        if fixed {
            params.odds_mode = String::from_str(&f.env, "fixed");
            params.challenger_payout_bps = 10_000 + rng.below(20_001) as u32;
        }
        if attributed {
            params.agent_owner_recipient = Some(agent.clone());
        }
        let id = f.client().create_claim(&creator, &params);

        let mut challengers = std::vec::Vec::new();
        for _ in 0..1 + rng.below(4) {
            let stake = MIN_STAKE + rng.below(20 * USDC as u64) as i128;
            let who = f.user(stake);
            // A fixed-odds challenge the creator cannot cover is refused before
            // any money moves; that is covered elsewhere, so just skip it.
            if f.client()
                .try_challenge_claim(&who, &id, &stake, &None)
                .is_ok()
            {
                challengers.push((who, stake));
            }
        }
        if challengers.is_empty() {
            continue;
        }
        let inflow = f.escrow_balance();
        let fees_now = || {
            (
                f.client().get_accrued_fees(&f.platform),
                f.client().get_accrued_fees(&agent),
            )
        };
        let expect_legs = |profit: i128| {
            (
                profit * p as i128 / BPS_DIVISOR,
                if attributed {
                    profit * o as i128 / BPS_DIVISOR
                } else {
                    0
                },
            )
        };

        f.advance_by(3_600);
        f.client()
            .resolve_claim(&id, &verdict, &f.str("verdict"), &77, &f.zero_hash());

        if verdict == WinnerSide::Creator {
            let profit = inflow - creator_stake;
            assert_eq!(
                fees_now(),
                expect_legs(profit),
                "round {round}: creator win"
            );
        } else {
            for (who, stake) in challengers.iter() {
                let before = fees_now();
                let quote = f.client().quote_challenger_payout(&id, who);
                let net = f.client().claim_challenger_payout(who, &id);
                let after = fees_now();
                let legs = (after.0 - before.0, after.1 - before.1);

                let profit = if quote.gross > *stake {
                    quote.gross - stake
                } else {
                    0
                };
                assert_eq!(legs, expect_legs(profit), "round {round}: challenger legs");
                assert_eq!(net, quote.net, "round {round}: quote vs payout");
                assert_eq!(net, quote.gross - legs.0 - legs.1, "round {round}");
                assert!(net >= *stake, "round {round}: principal lost");
            }
        }

        // Conservation to the stroop: participants plus fees is the inflow, and
        // the escrow holds exactly the fees not yet claimed.
        let fees = fees_now().0 + fees_now().1;
        let paid: i128 = core::iter::once(&creator)
            .chain(challengers.iter().map(|(who, _)| who))
            .map(|who| f.token().balance(who) + f.client().get_withdrawable(who))
            .sum();
        assert_eq!(paid + fees, inflow, "round {round}: conservation");
        assert_eq!(f.escrow_balance(), fees, "round {round}: escrow");
    }
}
