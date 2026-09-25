#![cfg(test)]
//! Settlement: conservation, principal protection, and the four verdict branches.
//!
//! Settlement is split in two, mirroring mimir-squad: `resolve_claim` is O(1) and
//! pays the creator's leg inline, then each challenger pulls via
//! `claim_challenger_payout`. Conservation is asserted over the whole lifecycle.

extern crate std;

use soroban_sdk::{testutils::Events as _, Address, Event, String};

use crate::test_common::{Fixture, USDC};
use crate::types::{Error, WinnerSide, CHALLENGE_LOCK_SECONDS};

/// Tokens actually delivered plus anything parked for later withdrawal.
fn credited(f: &Fixture, who: &Address) -> i128 {
    f.token().balance(who) + f.client().get_withdrawable(who)
}

// ── CREATOR wins ─────────────────────────────────────────────────────────────

#[test]
fn creator_wins_takes_whole_pool_less_profit_fee() {
    let f = Fixture::new(500, 0); // 5% platform fee
    let creator = f.user(100 * USDC);
    let c1 = f.user(100 * USDC);
    let c2 = f.user(100 * USDC);

    let id = f.client().create_claim(&creator, &f.params(10 * USDC));
    f.client().challenge_claim(&c1, &id, &(6 * USDC), &None);
    f.client().challenge_claim(&c2, &id, &(4 * USDC), &None);

    let inflow = 20 * USDC;
    assert_eq!(f.escrow_balance(), inflow);

    f.advance_by(3_600);
    f.client().resolve_claim(
        &id,
        &WinnerSide::Creator,
        &f.str("creator was right"),
        &90,
        &f.zero_hash(),
    );

    // Gross 20, principal 10, profit 10, fee 5% of 10 = 0.5. Paid inline: a
    // creator win is a single transfer, so no pull step is needed.
    let expected_fee = 5 * USDC / 10;
    assert_eq!(f.client().get_accrued_fees(&f.platform), expected_fee);
    assert_eq!(
        f.token().balance(&creator),
        90 * USDC + inflow - expected_fee
    );

    // Nothing is owed to challengers.
    assert_eq!(f.client().get_claim(&id).remaining_escrow, 0);
    assert_eq!(f.escrow_balance(), expected_fee);
    let stats = f.client().get_platform_stats();
    assert_eq!(stats.fees_accrued, expected_fee);
    assert_eq!(stats.resolved, 1);
}

#[test]
fn a_creator_win_leaves_challengers_nothing_to_pull() {
    let f = Fixture::new(0, 0);
    let creator = f.user(100 * USDC);
    let c1 = f.user(100 * USDC);

    let id = f.client().create_claim(&creator, &f.params(10 * USDC));
    f.client().challenge_claim(&c1, &id, &(10 * USDC), &None);
    f.advance_by(3_600);
    f.client()
        .resolve_claim(&id, &WinnerSide::Creator, &f.str("ok"), &80, &f.zero_hash());

    let err = f
        .client()
        .try_claim_challenger_payout(&c1, &id)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::ChallengersDidNotWin);
    assert_eq!(f.client().quote_challenger_payout(&id, &c1).net, 0);
    assert_eq!(f.token().balance(&c1), 90 * USDC);
}

// ── CHALLENGERS win, pool mode ───────────────────────────────────────────────

#[test]
fn challengers_win_pool_mode_is_pro_rata_and_conserved() {
    let f = Fixture::new(1_000, 0); // 10% platform fee, the hard cap
    let creator = f.user(100 * USDC);
    let c1 = f.user(100 * USDC);
    let c2 = f.user(100 * USDC);

    let id = f.client().create_claim(&creator, &f.params(9 * USDC));
    f.client().challenge_claim(&c1, &id, &(6 * USDC), &None);
    f.client().challenge_claim(&c2, &id, &(3 * USDC), &None);
    let inflow = 18 * USDC;

    f.advance_by(3_600);
    f.client().resolve_claim(
        &id,
        &WinnerSide::Challengers,
        &f.str("challengers right"),
        &95,
        &f.zero_hash(),
    );

    // resolve_claim itself pays nobody on this branch; the whole pot is left for
    // the challengers to pull.
    assert_eq!(f.client().get_claim(&id).remaining_escrow, inflow);
    assert_eq!(f.escrow_balance(), inflow);

    // c1: share = 6*9/9 = 6, gross 12, profit 6, fee 0.6 → 11.4
    let c1_fee = 6 * USDC / 10;
    assert_eq!(
        f.client().claim_challenger_payout(&c1, &id),
        12 * USDC - c1_fee
    );
    // c2 is the final claimant: gross = remaining 6, profit 3, fee 0.3 → 5.7
    let c2_fee = 3 * USDC / 10;
    assert_eq!(
        f.client().claim_challenger_payout(&c2, &id),
        6 * USDC - c2_fee
    );

    assert_eq!(f.token().balance(&c1), 94 * USDC + 12 * USDC - c1_fee);
    assert_eq!(f.token().balance(&c2), 97 * USDC + 6 * USDC - c2_fee);
    assert_eq!(f.client().get_accrued_fees(&f.platform), c1_fee + c2_fee);

    // paid + fees == inflow exactly, and the escrow holds only the fees.
    assert_eq!(f.client().get_claim(&id).remaining_escrow, 0);
    assert_eq!(f.escrow_balance(), c1_fee + c2_fee);
}

/// Pool-mode shares truncate. The final claimant absorbs the remainder, so the
/// escrow empties completely instead of stranding dust.
#[test]
fn pool_mode_truncation_dust_is_absorbed_by_the_last_claimant() {
    let f = Fixture::new(0, 0);
    let creator = f.user(100 * USDC);
    let c1 = f.user(100 * USDC);
    let c2 = f.user(100 * USDC);
    let c3 = f.user(100 * USDC);

    let stakes = [3 * USDC + 1, 3 * USDC + 1, 4 * USDC + 1];
    let id = f.client().create_claim(&creator, &(f.params(10 * USDC + 1)));
    f.client().challenge_claim(&c1, &id, &stakes[0], &None);
    f.client().challenge_claim(&c2, &id, &stakes[1], &None);
    f.client().challenge_claim(&c3, &id, &stakes[2], &None);
    let inflow = f.escrow_balance();

    f.advance_by(3_600);
    f.client().resolve_claim(
        &id,
        &WinnerSide::Challengers,
        &f.str("x"),
        &70,
        &f.zero_hash(),
    );
    let paid = f.settle_all_challengers(id);

    // Every winner got at least their principal back.
    for (who, stake) in [(&c1, stakes[0]), (&c2, stakes[1]), (&c3, stakes[2])] {
        assert!(f.token().balance(who) >= 100 * USDC - stake + stake);
    }
    // Fee-free, so every atomic unit was distributed: no dust left over.
    assert_eq!(paid, inflow);
    assert_eq!(f.client().get_claim(&id).remaining_escrow, 0);
    assert_eq!(f.escrow_balance(), 0);
}

// ── CHALLENGERS win, fixed odds ──────────────────────────────────────────────

#[test]
fn fixed_odds_challenger_win_refunds_unspent_liability_without_fee() {
    let f = Fixture::new(1_000, 0);
    let creator = f.user(100 * USDC);
    let c1 = f.user(100 * USDC);

    let mut params = f.params(10 * USDC);
    params.odds_mode = f.str("fixed");
    params.challenger_payout_bps = 20_000; // 2x
    params.max_challengers = 5;
    let id = f.client().create_claim(&creator, &params);

    // 3 USDC at 2x → gross 6, profit 3 reserved against the creator's 10.
    f.client().challenge_claim(&c1, &id, &(3 * USDC), &None);
    let expected_liquidity_event = crate::events::FixedOddsLiquidityReserved {
        id,
        challenger: c1.clone(),
        stake: 3 * USDC,
        gross: 6 * USDC,
        profit: 3 * USDC,
        reserved_creator_liability: 3 * USDC,
        available_creator_liquidity: 7 * USDC,
    }
    .to_xdr(&f.env, &f.contract_id);
    let emitted_events = f.env.events().all();
    assert!(emitted_events
        .events()
        .iter()
        .any(|event| event == &expected_liquidity_event));
    assert_eq!(
        f.client().get_claim_market_config(&id).challenger_payout_bps,
        20_000
    );
    assert_eq!(f.client().get_claim(&id).reserved_creator_liability, 3 * USDC);

    f.advance_by(3_600);
    f.client().resolve_claim(
        &id,
        &WinnerSide::Challengers,
        &f.str("won"),
        &99,
        &f.zero_hash(),
    );

    // The creator's 7 USDC of never-reserved liability comes back at resolve
    // time, inline and with no fee — reserved_creator_liability makes that an
    // O(1) computation, no roster walk needed.
    assert_eq!(f.token().balance(&creator), 90 * USDC + 7 * USDC);
    assert_eq!(f.client().get_claim(&id).remaining_escrow, 6 * USDC);

    // Challenger: gross 6, principal 3, profit 3, fee 0.3 → 5.7
    let fee = 3 * USDC / 10;
    assert_eq!(
        f.client().claim_challenger_payout(&c1, &id),
        6 * USDC - fee
    );
    assert_eq!(f.token().balance(&c1), 97 * USDC + 6 * USDC - fee);
    assert_eq!(f.client().get_accrued_fees(&f.platform), fee);
    assert_eq!(f.escrow_balance(), fee);
    assert_eq!(f.client().get_claim(&id).remaining_escrow, 0);
}

#[test]
fn fixed_odds_with_several_challengers_conserves_exactly() {
    let f = Fixture::new(600, 400); // 6% + 4% = the cap
    let creator = f.user(100 * USDC);
    let agent = f.user(0);

    let mut params = f.params(20 * USDC);
    params.odds_mode = f.str("fixed");
    params.challenger_payout_bps = 17_500; // 1.75x
    params.max_challengers = 10;
    params.agent_owner_recipient = Some(agent.clone());
    let id = f.client().create_claim(&creator, &params);

    let stakes = [4 * USDC + 7, 5 * USDC + 3, 2 * USDC + 1];
    let mut challengers = std::vec::Vec::new();
    for stake in stakes {
        let who = f.user(100 * USDC);
        f.client().challenge_claim(&who, &id, &stake, &None);
        challengers.push((who, stake));
    }
    let inflow = f.escrow_balance();
    let reserved = f.client().get_claim(&id).reserved_creator_liability;

    f.advance_by(3_600);
    f.client().resolve_claim(
        &id,
        &WinnerSide::Challengers,
        &f.str("fixed win"),
        &91,
        &f.zero_hash(),
    );
    // The creator keeps the liability nobody claimed against.
    assert_eq!(f.token().balance(&creator), 80 * USDC + (20 * USDC - reserved));

    let paid_to_challengers = f.settle_all_challengers(id);
    let fees =
        f.client().get_accrued_fees(&f.platform) + f.client().get_accrued_fees(&agent);

    // Fixed odds conserves exactly: no truncation slack anywhere.
    assert_eq!(paid_to_challengers + fees, stakes.iter().sum::<i128>() + reserved);
    assert_eq!((20 * USDC - reserved) + paid_to_challengers + fees, inflow);
    assert_eq!(f.client().get_claim(&id).remaining_escrow, 0);
    assert_eq!(f.escrow_balance(), fees);

    for (who, stake) in challengers.iter() {
        assert!(f.token().balance(who) >= 100 * USDC, "below principal");
        let _ = stake;
    }
}

#[test]
fn fixed_odds_rejects_challenge_creator_cannot_cover() {
    let f = Fixture::new(0, 0);
    let creator = f.user(100 * USDC);
    let c1 = f.user(1_000 * USDC);

    let mut params = f.params(10 * USDC);
    params.odds_mode = f.str("fixed");
    params.challenger_payout_bps = 20_000;
    params.max_challengers = 5;
    let id = f.client().create_claim(&creator, &params);

    // 11 USDC at 2x needs 11 of creator liability; only 10 exists.
    let err = f
        .client()
        .try_challenge_claim(&c1, &id, &(11 * USDC), &None)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::InsufficientCreatorLiquidity);

    // 10 USDC is exactly coverable.
    f.client().challenge_claim(&c1, &id, &(10 * USDC), &None);
    assert_eq!(
        f.client().get_claim(&id).reserved_creator_liability,
        10 * USDC
    );
    // A second challenger now has no liquidity left. The failed check must
    // happen before the token pull, and must leave the claim and both balances
    // untouched.
    let c2 = f.user(100 * USDC);
    let c2_before = f.token().balance(&c2);
    let escrow_before = f.escrow_balance();
    let claim_before = f.client().get_claim(&id);
    let err = f
        .client()
        .try_challenge_claim(&c2, &id, &(2 * USDC), &None)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::InsufficientCreatorLiquidity);
    assert_eq!(f.token().balance(&c2), c2_before);
    assert_eq!(f.escrow_balance(), escrow_before);
    assert_eq!(f.client().get_claim(&id), claim_before);
}

#[test]
fn fixed_odds_rejects_corrupt_reserved_liability_without_underflowing() {
    let f = Fixture::new(0, 0);
    let creator = f.user(100 * USDC);
    let challenger = f.user(100 * USDC);
    let mut params = f.params(10 * USDC);
    params.odds_mode = f.str("fixed");
    params.challenger_payout_bps = 20_000;
    let id = f.client().create_claim(&creator, &params);

    // Model a legacy/malformed row. The contract must fail closed rather than
    // calculate a negative available balance or wrap under release overflow
    // checks.
    let mut claim = f.client().get_claim(&id);
    claim.reserved_creator_liability = claim.creator_stake + 1;
    f.env.as_contract(&f.contract_id, || {
        crate::storage::set_claim(&f.env, id, &claim);
    });

    let err = f
        .client()
        .try_challenge_claim(&challenger, &id, &(2 * USDC), &None)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::InsufficientCreatorLiquidity);
    assert_eq!(
        f.client().get_claim(&id).reserved_creator_liability,
        claim.creator_stake + 1
    );
    assert_eq!(f.token().balance(&challenger), 100 * USDC);
    assert_eq!(f.escrow_balance(), 10 * USDC);
}

// ── DRAW / UNRESOLVABLE ──────────────────────────────────────────────────────

#[test]
fn draw_refunds_everyone_in_full_with_no_fee() {
    let f = Fixture::new(1_000, 0); // platform fee at the hard cap
    let creator = f.user(100 * USDC);
    let c1 = f.user(100 * USDC);
    let c2 = f.user(100 * USDC);

    let id = f.client().create_claim(&creator, &f.params(10 * USDC));
    f.client().challenge_claim(&c1, &id, &(5 * USDC), &None);
    f.client().challenge_claim(&c2, &id, &(7 * USDC), &None);

    f.advance_by(3_600);
    f.client().resolve_claim(
        &id,
        &WinnerSide::Draw,
        &f.str("ambiguous"),
        &10,
        &f.zero_hash(),
    );
    // The creator is refunded inline; challengers pull their own principal.
    assert_eq!(f.token().balance(&creator), 100 * USDC);
    assert_eq!(f.client().get_claim(&id).remaining_escrow, 12 * USDC);

    assert_eq!(f.client().claim_challenger_payout(&c1, &id), 5 * USDC);
    assert_eq!(f.client().claim_challenger_payout(&c2, &id), 7 * USDC);

    assert_eq!(f.token().balance(&c1), 100 * USDC);
    assert_eq!(f.token().balance(&c2), 100 * USDC);
    assert_eq!(f.client().get_accrued_fees(&f.platform), 0);
    assert_eq!(f.escrow_balance(), 0);
}

#[test]
fn unresolvable_refunds_everyone_in_full_with_no_fee() {
    let f = Fixture::new(1_000, 0);
    let creator = f.user(100 * USDC);
    let c1 = f.user(100 * USDC);

    let id = f.client().create_claim(&creator, &f.params(8 * USDC));
    f.client().challenge_claim(&c1, &id, &(8 * USDC), &None);

    f.advance_by(3_600);
    f.client().resolve_claim(
        &id,
        &WinnerSide::Unresolvable,
        &f.str("no source"),
        &0,
        &f.zero_hash(),
    );
    assert_eq!(f.client().claim_challenger_payout(&c1, &id), 8 * USDC);

    assert_eq!(f.token().balance(&creator), 100 * USDC);
    assert_eq!(f.token().balance(&c1), 100 * USDC);
    assert_eq!(f.client().get_accrued_fees(&f.platform), 0);
    assert_eq!(f.escrow_balance(), 0);
    assert_eq!(f.client().get_claim(&id).winner_side, WinnerSide::Unresolvable);
}

// ── Cross-outcome invariants ─────────────────────────────────────────────────

/// paid + fees <= inflow, and every winner keeps at least their principal, for
/// all four verdicts over the same market shape — measured across the full
/// lifecycle of resolve_claim plus N pull calls.
#[test]
fn conservation_holds_across_every_verdict() {
    for verdict in [
        WinnerSide::Creator,
        WinnerSide::Challengers,
        WinnerSide::Draw,
        WinnerSide::Unresolvable,
    ] {
        for odds in ["pool", "fixed"] {
            let f = Fixture::new(700, 300); // 7% + 3% = the 10% cap
            let creator = f.user(100 * USDC);
            let agent = f.user(0);

            let creator_stake = 12 * USDC + 7;
            let mut params = f.params(creator_stake);
            params.odds_mode = String::from_str(&f.env, odds);
            params.challenger_payout_bps = 15_000; // 1.5x
            params.agent_owner_recipient = Some(agent.clone());
            let id = f.client().create_claim(&creator, &params);

            let mut challengers = std::vec::Vec::new();
            for stake in [3 * USDC + 1, 4 * USDC + 3, 5 * USDC + 9] {
                let who = f.user(100 * USDC);
                f.client().challenge_claim(&who, &id, &stake, &None);
                challengers.push((who, stake));
            }

            let inflow = f.escrow_balance();
            f.advance_by(3_600);
            f.client()
                .resolve_claim(&id, &verdict, &f.str("verdict"), &88, &f.zero_hash());

            // Challengers pull unless the creator won.
            if verdict != WinnerSide::Creator {
                f.settle_all_challengers(id);
                assert_eq!(f.client().get_claim(&id).remaining_escrow, 0);
            }

            let fees = f.client().get_accrued_fees(&f.platform)
                + f.client().get_accrued_fees(&agent);
            let mut paid = credited(&f, &creator) - (100 * USDC - creator_stake);
            for (who, stake) in challengers.iter() {
                paid += credited(&f, who) - (100 * USDC - stake);
            }

            assert!(
                paid + fees <= inflow,
                "{:?}/{}: paid {} + fees {} exceeds inflow {}",
                verdict,
                odds,
                paid,
                fees,
                inflow
            );
            // Escrow still solvent: it holds exactly what has not been paid out.
            assert_eq!(f.escrow_balance(), inflow - paid);

            // Winners never dip below principal.
            match verdict {
                WinnerSide::Creator => {
                    assert!(f.token().balance(&creator) >= 100 * USDC);
                }
                WinnerSide::Challengers => {
                    for (who, _) in challengers.iter() {
                        assert!(
                            f.token().balance(who) >= 100 * USDC,
                            "{:?}/{}: winner below principal",
                            verdict,
                            odds
                        );
                    }
                }
                _ => {
                    assert_eq!(f.token().balance(&creator), 100 * USDC);
                    for (who, _) in challengers.iter() {
                        assert_eq!(f.token().balance(who), 100 * USDC);
                    }
                }
            }
        }
    }
}

/// With fees pinned at the cap and a crowded pool, the classic "10 USDC winning
/// 11 must not return under 10" case.
#[test]
fn winner_never_receives_less_than_principal_in_a_crowded_pool() {
    let f = Fixture::new(700, 300);
    let creator = f.user(1_000 * USDC);
    let id = f.client().create_claim(&creator, &f.params(2 * USDC));

    let mut challengers = std::vec::Vec::new();
    for _ in 0..20 {
        let who = f.user(100 * USDC);
        f.client().challenge_claim(&who, &id, &(10 * USDC), &None);
        challengers.push(who);
    }

    f.advance_by(3_600);
    f.client().resolve_claim(
        &id,
        &WinnerSide::Challengers,
        &f.str("thin profit"),
        &60,
        &f.zero_hash(),
    );
    f.settle_all_challengers(id);

    // share = 10 * 2 / 200 = 0.1 USDC profit each; a gross-charged fee would
    // have clawed into principal.
    for who in challengers.iter() {
        assert!(
            f.token().balance(who) >= 100 * USDC,
            "winner fell below principal: {}",
            f.token().balance(who)
        );
    }
    assert_eq!(f.client().get_claim(&id).remaining_escrow, 0);
}

// ── Pull-settlement gating ───────────────────────────────────────────────────

#[test]
fn a_challenger_can_only_pull_once() {
    let f = Fixture::new(0, 0);
    let creator = f.user(100 * USDC);
    let c1 = f.user(100 * USDC);
    let c2 = f.user(100 * USDC);
    let id = f.client().create_claim(&creator, &f.params(10 * USDC));
    f.client().challenge_claim(&c1, &id, &(5 * USDC), &None);
    f.client().challenge_claim(&c2, &id, &(5 * USDC), &None);
    f.advance_by(3_600);
    f.client()
        .resolve_claim(&id, &WinnerSide::Draw, &f.str("d"), &1, &f.zero_hash());

    f.client().claim_challenger_payout(&c1, &id);
    assert_eq!(f.client().claim_challenger_payout(&c1, &id), 0);

    // The roster reports who has settled.
    let roster = f.client().get_challenger_list(&id);
    assert!(roster.get(0).unwrap().claimed);
    assert!(!roster.get(1).unwrap().claimed);
    assert!(f.client().quote_challenger_payout(&id, &c1).claimed);

    // The double pull did not drain the escrow owed to c2.
    assert_eq!(f.client().get_claim(&id).remaining_escrow, 5 * USDC);
    assert_eq!(f.escrow_balance(), 5 * USDC);
}

/// If a challenger never pulls, `challenger_claims` never reaches
/// `challenger_count`, so the dust branch is never taken and their share simply
/// stays in escrow. Safe (never an overpayment) and the same behaviour
/// mimir-squad already ships; documented rather than worked around.
#[test]
fn an_abandoned_share_stays_in_escrow() {
    let f = Fixture::new(0, 0);
    let creator = f.user(100 * USDC);
    let c1 = f.user(100 * USDC);
    let c2 = f.user(100 * USDC);
    let id = f.client().create_claim(&creator, &f.params(10 * USDC));
    f.client().challenge_claim(&c1, &id, &(5 * USDC), &None);
    f.client().challenge_claim(&c2, &id, &(5 * USDC), &None);
    f.advance_by(3_600);
    f.client().resolve_claim(
        &id,
        &WinnerSide::Challengers,
        &f.str("won"),
        &80,
        &f.zero_hash(),
    );

    // Only c1 pulls; c2 walks away. c1 gets the formula amount, not the pot.
    assert_eq!(f.client().claim_challenger_payout(&c1, &id), 10 * USDC);
    assert_eq!(f.client().get_claim(&id).remaining_escrow, 10 * USDC);
    assert_eq!(f.escrow_balance(), 10 * USDC);

    // c2's entitlement is still there whenever they come back for it.
    assert_eq!(f.client().claim_challenger_payout(&c2, &id), 10 * USDC);
    assert_eq!(f.escrow_balance(), 0);
}

#[test]
fn pulling_before_resolution_is_rejected() {
    let f = Fixture::new(0, 0);
    let creator = f.user(100 * USDC);
    let c1 = f.user(100 * USDC);
    let id = f.client().create_claim(&creator, &f.params(10 * USDC));
    f.client().challenge_claim(&c1, &id, &(5 * USDC), &None);

    let err = f
        .client()
        .try_claim_challenger_payout(&c1, &id)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::ClaimNotResolved);
}

#[test]
fn a_non_challenger_cannot_pull() {
    let f = Fixture::new(0, 0);
    let creator = f.user(100 * USDC);
    let c1 = f.user(100 * USDC);
    let stranger = f.user(100 * USDC);
    let id = f.client().create_claim(&creator, &f.params(10 * USDC));
    f.client().challenge_claim(&c1, &id, &(5 * USDC), &None);
    f.advance_by(3_600);
    f.client()
        .resolve_claim(&id, &WinnerSide::Draw, &f.str("d"), &1, &f.zero_hash());

    let err = f
        .client()
        .try_claim_challenger_payout(&stranger, &id)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::NotAChallenger);
    // The creator is not on the roster either.
    let err = f
        .client()
        .try_claim_challenger_payout(&creator, &id)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::NotAChallenger);
}

#[test]
fn pulling_requires_the_challengers_signature() {
    let f = Fixture::new(0, 0);
    let creator = f.user(100 * USDC);
    let c1 = f.user(100 * USDC);
    let id = f.client().create_claim(&creator, &f.params(10 * USDC));
    f.client().challenge_claim(&c1, &id, &(5 * USDC), &None);
    f.advance_by(3_600);
    f.client()
        .resolve_claim(&id, &WinnerSide::Draw, &f.str("d"), &1, &f.zero_hash());

    f.env.set_auths(&[]);
    assert!(f.client().try_claim_challenger_payout(&c1, &id).is_err());
}

#[test]
fn a_quote_matches_what_the_pull_actually_pays() {
    let f = Fixture::new(800, 200);
    let creator = f.user(100 * USDC);
    let agent = f.user(0);
    let c1 = f.user(100 * USDC);
    let c2 = f.user(100 * USDC);

    let mut params = f.params(11 * USDC + 3);
    params.agent_owner_recipient = Some(agent);
    let id = f.client().create_claim(&creator, &params);
    f.client().challenge_claim(&c1, &id, &(3 * USDC + 1), &None);
    f.client().challenge_claim(&c2, &id, &(7 * USDC + 5), &None);
    f.advance_by(3_600);
    f.client().resolve_claim(
        &id,
        &WinnerSide::Challengers,
        &f.str("q"),
        &70,
        &f.zero_hash(),
    );

    for who in [&c1, &c2] {
        let quote = f.client().quote_challenger_payout(&id, who);
        let net = f.client().claim_challenger_payout(who, &id);
        assert_eq!(quote.net, net);
        assert_eq!(quote.gross - quote.fee, net);
        assert!(!quote.claimed);
    }
}

// ── Oracle gating ────────────────────────────────────────────────────────────

#[test]
fn resolve_before_deadline_is_rejected() {
    let f = Fixture::new(0, 0);
    let creator = f.user(100 * USDC);
    let c1 = f.user(100 * USDC);
    let id = f.client().create_claim(&creator, &f.params(5 * USDC));
    f.client().challenge_claim(&c1, &id, &(5 * USDC), &None);

    let err = f
        .client()
        .try_resolve_claim(
            &id,
            &WinnerSide::Creator,
            &f.str("early"),
            &50,
            &f.zero_hash(),
        )
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::NotYetExpired);
}

#[test]
fn resolve_requires_the_oracle_signature() {
    let f = Fixture::new(0, 0);
    let creator = f.user(100 * USDC);
    let c1 = f.user(100 * USDC);
    let id = f.client().create_claim(&creator, &f.params(5 * USDC));
    f.client().challenge_claim(&c1, &id, &(5 * USDC), &None);
    f.advance_by(3_600);

    // No authorizations supplied at all: the oracle's require_auth must fail.
    f.env.set_auths(&[]);
    assert!(f
        .client()
        .try_resolve_claim(
            &id,
            &WinnerSide::Creator,
            &f.str("nope"),
            &50,
            &f.zero_hash()
        )
        .is_err());
}

#[test]
fn an_unchallenged_claim_cannot_be_resolved() {
    let f = Fixture::new(0, 0);
    let creator = f.user(100 * USDC);
    let id = f.client().create_claim(&creator, &f.params(5 * USDC));
    f.advance_by(3_600);

    let err = f
        .client()
        .try_resolve_claim(
            &id,
            &WinnerSide::Creator,
            &f.str("no challengers"),
            &50,
            &f.zero_hash(),
        )
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::ClaimNotActive);
}

#[test]
fn resolving_twice_with_same_inputs_is_idempotent() {
    let f = Fixture::new(0, 0);
    let creator = f.user(100 * USDC);
    let c1 = f.user(100 * USDC);
    let id = f.client().create_claim(&creator, &f.params(5 * USDC));
    f.client().challenge_claim(&c1, &id, &(5 * USDC), &None);
    f.advance_by(3_600);

    // First call succeeds.
    f.client()
        .resolve_claim(&id, &WinnerSide::Draw, &f.str("a"), &1, &f.zero_hash());
    
    // Second call with exact same inputs succeeds without modifying state.
    f.client()
        .resolve_claim(&id, &WinnerSide::Draw, &f.str("a"), &1, &f.zero_hash());

    let claim = f.client().get_claim(&id);
    assert_eq!(claim.state, crate::types::ClaimState::Resolved);
    assert_eq!(claim.winner_side, WinnerSide::Draw);
}

#[test]
fn resolving_twice_with_different_inputs_is_rejected() {
    let f = Fixture::new(0, 0);
    let creator = f.user(100 * USDC);
    let c1 = f.user(100 * USDC);
    let id = f.client().create_claim(&creator, &f.params(5 * USDC));
    f.client().challenge_claim(&c1, &id, &(5 * USDC), &None);
    f.advance_by(3_600);

    f.client()
        .resolve_claim(&id, &WinnerSide::Draw, &f.str("a"), &1, &f.zero_hash());
    let err = f
        .client()
        .try_resolve_claim(&id, &WinnerSide::Creator, &f.str("a"), &1, &f.zero_hash())
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::ClaimNotActive);
}

#[test]
fn verdict_none_is_not_a_valid_resolution() {
    let f = Fixture::new(0, 0);
    let creator = f.user(100 * USDC);
    let c1 = f.user(100 * USDC);
    let id = f.client().create_claim(&creator, &f.params(5 * USDC));
    f.client().challenge_claim(&c1, &id, &(5 * USDC), &None);
    f.advance_by(3_600);

    let err = f
        .client()
        .try_resolve_claim(&id, &WinnerSide::None, &f.str("?"), &0, &f.zero_hash())
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::InvalidVerdict);
}

// ── Pull-payment fallback ────────────────────────────────────────────────────

#[test]
fn a_failed_payout_is_parked_and_withdrawable_later() {
    let f = Fixture::with_stub_token(0, 0);
    let creator = f.user(100 * USDC);
    let c1 = f.user(100 * USDC);

    let id = f.client().create_claim(&creator, &f.params(10 * USDC));
    f.client().challenge_claim(&c1, &id, &(10 * USDC), &None);
    f.advance_by(3_600);

    // The creator can no longer receive: resolution must not fail for it.
    f.stub().set_blocked(&creator, &true);
    f.client()
        .resolve_claim(&id, &WinnerSide::Draw, &f.str("drawn"), &50, &f.zero_hash());

    // The creator's refund was parked rather than lost.
    assert_eq!(f.token().balance(&creator), 90 * USDC);
    assert_eq!(f.client().get_withdrawable(&creator), 10 * USDC);

    // The challenger pulls normally.
    f.client().claim_challenger_payout(&c1, &id);
    assert_eq!(f.token().balance(&c1), 100 * USDC);

    // Nothing to withdraw for someone who was paid normally.
    assert_eq!(f.client().withdraw(&c1), 0);

    // Once unblocked, the parked amount is pullable exactly once.
    f.stub().set_blocked(&creator, &false);
    assert_eq!(f.client().withdraw(&creator), 10 * USDC);
    assert_eq!(f.token().balance(&creator), 100 * USDC);
    assert_eq!(f.client().get_withdrawable(&creator), 0);
    assert_eq!(f.client().withdraw(&creator), 0);
}

/// A challenger who cannot receive still has their settlement recorded: the
/// amount is parked, their slot is marked claimed, and the escrow accounting
/// moves on so nobody else is blocked.
#[test]
fn a_blocked_challenger_has_their_payout_parked() {
    let f = Fixture::with_stub_token(0, 0);
    let creator = f.user(100 * USDC);
    let c1 = f.user(100 * USDC);
    let c2 = f.user(100 * USDC);

    let mut params = f.params(10 * USDC);
    params.max_challengers = 5;
    let id = f.client().create_claim(&creator, &params);
    f.client().challenge_claim(&c1, &id, &(5 * USDC), &None);
    f.client().challenge_claim(&c2, &id, &(5 * USDC), &None);
    f.advance_by(3_600);

    f.client().resolve_claim(
        &id,
        &WinnerSide::Challengers,
        &f.str("both won"),
        &77,
        &f.zero_hash(),
    );

    f.stub().set_blocked(&c1, &true);
    f.client().claim_challenger_payout(&c1, &id);
    assert_eq!(f.client().get_withdrawable(&c1), 10 * USDC);
    assert_eq!(f.token().balance(&c1), 95 * USDC);

    // c2's settlement is entirely unaffected.
    f.client().claim_challenger_payout(&c2, &id);
    assert_eq!(f.token().balance(&c2), 105 * USDC);
    assert_eq!(f.client().get_claim(&id).remaining_escrow, 0);

    // And c1 can retrieve the parked amount later.
    f.stub().set_blocked(&c1, &false);
    assert_eq!(f.client().withdraw(&c1), 10 * USDC);
    assert_eq!(f.token().balance(&c1), 105 * USDC);
    assert_eq!(f.escrow_balance(), 0);
}

/// A fee-on-transfer or rebasing asset would break escrow conservation, so the
/// exact-amount check must reject it at the door.
#[test]
fn a_non_exact_token_is_rejected_on_stake_pull() {
    let f = Fixture::with_stub_token(0, 0);
    let creator = f.user(100 * USDC);
    f.stub().set_skim_bps(&100); // 1% skim

    let err = f
        .client()
        .try_create_claim(&creator, &f.params(10 * USDC))
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::UnsupportedToken);
}

// ── Anti-sniping ─────────────────────────────────────────────────────────────

#[test]
fn a_challenge_inside_the_lock_window_is_rejected() {
    let f = Fixture::new(0, 0);
    let creator = f.user(100 * USDC);
    let c1 = f.user(100 * USDC);
    let params = f.params(10 * USDC);
    let deadline = params.deadline;
    let id = f.client().create_claim(&creator, &params);

    // Exactly on the boundary is still allowed.
    f.advance_to(deadline - CHALLENGE_LOCK_SECONDS);
    f.client().challenge_claim(&c1, &id, &(5 * USDC), &None);

    // One second later it is not.
    let c2 = f.user(100 * USDC);
    f.advance_by(1);
    let err = f
        .client()
        .try_challenge_claim(&c2, &id, &(5 * USDC), &None)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::ChallengeWindowClosed);
}

// ── Confidence validation ─────────────────────────────────────────────────────

/// Confidence of exactly 100 is the maximum valid value and must be accepted.
#[test]
fn confidence_100_is_accepted() {
    let f = Fixture::new(0, 0);
    let creator = f.user(100 * USDC);
    let c1 = f.user(100 * USDC);

    let id = f.client().create_claim(&creator, &f.params(5 * USDC));
    f.client().challenge_claim(&c1, &id, &(5 * USDC), &None);
    f.advance_by(3_600);

    // Should not error.
    f.client()
        .resolve_claim(&id, &WinnerSide::Creator, &f.str("sure"), &100, &f.zero_hash());
    assert_eq!(f.client().get_claim(&id).confidence, 100);
}

/// Confidence of 0 is the minimum valid value and must be accepted.
#[test]
fn confidence_0_is_accepted() {
    let f = Fixture::new(0, 0);
    let creator = f.user(100 * USDC);
    let c1 = f.user(100 * USDC);

    let id = f.client().create_claim(&creator, &f.params(5 * USDC));
    f.client().challenge_claim(&c1, &id, &(5 * USDC), &None);
    f.advance_by(3_600);

    f.client()
        .resolve_claim(&id, &WinnerSide::Unresolvable, &f.str("none"), &0, &f.zero_hash());
    assert_eq!(f.client().get_claim(&id).confidence, 0);
}

/// Confidence of 101 is the first out-of-range value and must be rejected.
#[test]
fn confidence_101_is_rejected() {
    let f = Fixture::new(0, 0);
    let creator = f.user(100 * USDC);
    let c1 = f.user(100 * USDC);

    let id = f.client().create_claim(&creator, &f.params(5 * USDC));
    f.client().challenge_claim(&c1, &id, &(5 * USDC), &None);
    f.advance_by(3_600);

    let err = f
        .client()
        .try_resolve_claim(&id, &WinnerSide::Creator, &f.str("nope"), &101, &f.zero_hash())
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::InvalidConfidence);

    // The claim must remain Active: no state change on a rejected call.
    assert_eq!(f.client().get_claim(&id).state, crate::types::ClaimState::Active);
}

/// Very large confidence values (u32::MAX) are also rejected.
#[test]
fn confidence_u32_max_is_rejected() {
    let f = Fixture::new(0, 0);
    let creator = f.user(100 * USDC);
    let c1 = f.user(100 * USDC);

    let id = f.client().create_claim(&creator, &f.params(5 * USDC));
    f.client().challenge_claim(&c1, &id, &(5 * USDC), &None);
    f.advance_by(3_600);

    let err = f
        .client()
        .try_resolve_claim(&id, &WinnerSide::Creator, &f.str("overflow"), &u32::MAX, &f.zero_hash())
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::InvalidConfidence);
}

/// Boundary value 99: last value strictly below 100, must be accepted.
#[test]
fn confidence_99_is_accepted() {
    let f = Fixture::new(0, 0);
    let creator = f.user(100 * USDC);
    let c1 = f.user(100 * USDC);

    let id = f.client().create_claim(&creator, &f.params(5 * USDC));
    f.client().challenge_claim(&c1, &id, &(5 * USDC), &None);
    f.advance_by(3_600);

    f.client()
        .resolve_claim(&id, &WinnerSide::Creator, &f.str("almost"), &99, &f.zero_hash());
    assert_eq!(f.client().get_claim(&id).confidence, 99);
}

/// An out-of-range confidence leaves the escrow completely untouched:
/// conservation is preserved even when the call is rejected.
#[test]
fn invalid_confidence_does_not_disturb_escrow() {
    let f = Fixture::new(500, 0);
    let creator = f.user(100 * USDC);
    let c1 = f.user(100 * USDC);

    let id = f.client().create_claim(&creator, &f.params(10 * USDC));
    f.client().challenge_claim(&c1, &id, &(10 * USDC), &None);
    let inflow = f.escrow_balance();
    f.advance_by(3_600);

    // Attempt with invalid confidence; must fail.
    let _ = f
        .client()
        .try_resolve_claim(&id, &WinnerSide::Creator, &f.str("bad"), &200, &f.zero_hash());

    // Escrow must be untouched.
    assert_eq!(f.escrow_balance(), inflow);
    // No fees accrued.
    assert_eq!(f.client().get_accrued_fees(&f.platform), 0);
}

/// Regression: the existing InvalidVerdict check is ordered before the new
/// confidence check. A WinnerSide::None with an out-of-range confidence returns
/// InvalidVerdict, not InvalidConfidence.
#[test]
fn invalid_verdict_takes_precedence_over_invalid_confidence() {
    let f = Fixture::new(0, 0);
    let creator = f.user(100 * USDC);
    let c1 = f.user(100 * USDC);

    let id = f.client().create_claim(&creator, &f.params(5 * USDC));
    f.client().challenge_claim(&c1, &id, &(5 * USDC), &None);
    f.advance_by(3_600);

    let err = f
        .client()
        .try_resolve_claim(&id, &WinnerSide::None, &f.str("?"), &200, &f.zero_hash())
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::InvalidVerdict);
}

/// Confidence is stored on the claim and retrievable after resolution.
#[test]
fn resolved_confidence_is_stored_and_readable() {
    let f = Fixture::new(0, 0);
    let creator = f.user(100 * USDC);
    let c1 = f.user(100 * USDC);

    let id = f.client().create_claim(&creator, &f.params(5 * USDC));
    f.client().challenge_claim(&c1, &id, &(5 * USDC), &None);
    f.advance_by(3_600);

    f.client()
        .resolve_claim(&id, &WinnerSide::Draw, &f.str("draw"), &42, &f.zero_hash());

    let claim = f.client().get_claim(&id);
    assert_eq!(claim.confidence, 42);
}
