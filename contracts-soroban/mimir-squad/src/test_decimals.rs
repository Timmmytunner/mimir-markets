#![cfg(test)]
//! USDC scale: the escrow token must report exactly `USDC_DECIMALS`, and shares —
//! which equal deposited atomic units — are never rescaled, up to i64::MAX.

extern crate std;

use soroban_sdk::testutils::Address as _;
use soroban_sdk::{Address, Env};

use crate::contract::{MimirSquad, MimirSquadClient};
use crate::test_common::{Fixture, DEFAULT_DURATION};
use crate::types::{Error, MAX_FEE_BPS, RESULT_CANCELLED, SIDE_A, SIDE_B, USDC_DECIMALS};

/// A token that reports whatever scale it was registered with, and nothing else:
/// `initialize` must read `decimals()` before it touches any other entry point.
mod scaled_token {
    use soroban_sdk::{contract, contractimpl, symbol_short, Env};

    #[contract]
    pub struct ScaledToken;

    #[contractimpl]
    impl ScaledToken {
        pub fn __constructor(env: Env, decimals: u32) {
            env.storage()
                .instance()
                .set(&symbol_short!("decimals"), &decimals);
        }

        pub fn decimals(env: Env) -> u32 {
            env.storage()
                .instance()
                .get(&symbol_short!("decimals"))
                .unwrap()
        }
    }
}

/// A contract with no `decimals()` at all, so not a SEP-41 token.
mod no_decimals_token {
    use soroban_sdk::{contract, contractimpl, Address, Env};

    #[contract]
    pub struct NoDecimalsToken;

    #[contractimpl]
    impl NoDecimalsToken {
        pub fn balance(_env: Env, _id: Address) -> i128 {
            0
        }
    }
}

/// An uninitialized squad pool in a fresh environment.
fn bare_squad(env: &Env) -> MimirSquadClient<'_> {
    env.mock_all_auths();
    MimirSquadClient::new(env, &env.register(MimirSquad, ()))
}

fn try_init(squad: &MimirSquadClient, token: &Address) -> Result<(), Error> {
    let who = Address::generate(&squad.env);
    match squad.try_initialize(token, &who, &who) {
        Ok(_) => Ok(()),
        Err(err) => Err(err.unwrap()),
    }
}

// ── The scale is enforced at initialize ──────────────────────────────────────

#[test]
fn the_usdc_sac_reports_exactly_the_enforced_scale() {
    let f = Fixture::new();
    assert_eq!(f.token().decimals(), USDC_DECIMALS);
}

#[test]
fn initialize_rejects_a_token_at_any_other_scale() {
    for decimals in [0u32, 6, USDC_DECIMALS - 1, USDC_DECIMALS + 1, 18] {
        let env = Env::default();
        let squad = bare_squad(&env);
        let token = env.register(scaled_token::ScaledToken, (decimals,));

        assert_eq!(
            try_init(&squad, &token),
            Err(Error::UnsupportedDecimals),
            "a {decimals}-decimal token was accepted"
        );
        assert_eq!(
            squad.try_get_usdc().unwrap_err().unwrap(),
            Error::NotInitialized
        );
    }
}

#[test]
fn a_rejected_initialize_leaves_the_pool_initializable() {
    let env = Env::default();
    let squad = bare_squad(&env);

    let wrong = env.register(scaled_token::ScaledToken, (6u32,));
    assert_eq!(try_init(&squad, &wrong), Err(Error::UnsupportedDecimals));

    let right = env.register(scaled_token::ScaledToken, (USDC_DECIMALS,));
    assert_eq!(try_init(&squad, &right), Ok(()));
    assert_eq!(squad.get_usdc(), right);
}

#[test]
fn initialize_rejects_a_token_that_cannot_report_its_scale() {
    let env = Env::default();
    let squad = bare_squad(&env);

    let no_decimals = env.register(no_decimals_token::NoDecimalsToken, ());
    assert_eq!(try_init(&squad, &no_decimals), Err(Error::UnsupportedToken));

    let nothing = Address::generate(&env);
    assert_eq!(try_init(&squad, &nothing), Err(Error::UnsupportedToken));

    assert_eq!(
        squad.try_get_usdc().unwrap_err().unwrap(),
        Error::NotInitialized
    );
}

// ── Amounts at the i64 ceiling ───────────────────────────────────────────────

/// Both pools together at exactly i64::MAX stroops (~922 billion USDC; a classic
/// Stellar account cannot hold more than i64::MAX of an asset), with the fee at
/// its cap. `claim` forms `(pool_a + pool_b) * principal`; at this size that
/// product is ~2^124 and must still fit, and the escrow must drain to the stroop
/// for either winning side and for a cancellation.
#[test]
fn pools_at_the_i64_ceiling_settle_exactly_without_overflow() {
    let a1_stake: i128 = (1 << 61) + 3;
    let a2_stake: i128 = (1 << 60) + 11;
    let b1_stake: i128 = (1 << 61) - 5;
    let b2_stake: i128 = i64::MAX as i128 - a1_stake - a2_stake - b1_stake;

    for result in [SIDE_A, SIDE_B, RESULT_CANCELLED] {
        let f = Fixture::new();
        let captain = f.user(0);
        let id = f.market(&captain, MAX_FEE_BPS);

        let deposits = [
            (f.user(a1_stake), SIDE_A, a1_stake),
            (f.user(a2_stake), SIDE_A, a2_stake),
            (f.user(b1_stake), SIDE_B, b1_stake),
            (f.user(b2_stake), SIDE_B, b2_stake),
        ];
        for (who, side, amount) in deposits.iter() {
            f.client().deposit(who, &id, side, amount);
        }
        assert_eq!(f.escrow_balance(), i64::MAX as i128);

        f.advance_by(DEFAULT_DURATION);
        f.client().resolve(&id, &result);

        let mut paid = 0;
        for (who, side, _) in deposits.iter() {
            if result == RESULT_CANCELLED || *side == result {
                paid += f.client().claim(who, &id, side);
            }
        }
        let fees = if f.client().get_accrued_fees() > 0 {
            f.client().claim_fees()
        } else {
            0
        };

        assert_eq!(paid + fees, i64::MAX as i128, "result {result}");
        assert_eq!(f.escrow_balance(), 0, "result {result}");
    }
}
