#![cfg(test)]
//! USDC scale: the escrow token must report exactly `USDC_DECIMALS`, every amount
//! constant is written at that scale, and no amount is ever rescaled on its way
//! through the contract, from a single stroop up to i64::MAX.

extern crate std;

use soroban_sdk::testutils::Address as _;
use soroban_sdk::{Address, Env, String};

use crate::contract::{MimirMarket, MimirMarketClient};
use crate::test_common::{Fixture, USDC};
use crate::types::{Error, WinnerSide, MIN_STAKE, USDC_DECIMALS, USDC_UNIT};

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

/// An uninitialized market in a fresh environment.
fn bare_market(env: &Env) -> MimirMarketClient<'_> {
    env.mock_all_auths();
    MimirMarketClient::new(env, &env.register(MimirMarket, ()))
}

/// `initialize` with a zero fee policy, so only the token can make it fail.
fn try_init(market: &MimirMarketClient, token: &Address) -> Result<(), Error> {
    let who = Address::generate(&market.env);
    match market.try_initialize(&who, &who, token, &0, &0, &None) {
        Ok(_) => Ok(()),
        Err(err) => Err(err.unwrap()),
    }
}

// ── The scale is enforced at initialize ──────────────────────────────────────

#[test]
fn the_usdc_sac_reports_exactly_the_scale_the_constants_are_written_at() {
    let f = Fixture::new(0, 0);
    let decimals = f.token().decimals();
    assert_eq!(decimals, USDC_DECIMALS);
    assert_eq!(USDC_UNIT, 10i128.pow(decimals));
    assert_eq!(USDC_UNIT, USDC);
    // 2 whole USDC at the token's own scale, not at 6 decimals.
    assert_eq!(MIN_STAKE, 2 * 10i128.pow(decimals));
}

#[test]
fn initialize_rejects_a_token_at_any_other_scale() {
    // 6 is the EVM USDC scale this contract was ported from; 18 is the ERC-20
    // default; 0 and 8 bracket the real value by one in each direction.
    for decimals in [0u32, 6, USDC_DECIMALS - 1, USDC_DECIMALS + 1, 18] {
        let env = Env::default();
        let market = bare_market(&env);
        let token = env.register(scaled_token::ScaledToken, (decimals,));

        assert_eq!(
            try_init(&market, &token),
            Err(Error::UnsupportedDecimals),
            "a {decimals}-decimal token was accepted"
        );
        // Nothing was written.
        assert_eq!(
            market.try_get_usdc().unwrap_err().unwrap(),
            Error::NotInitialized
        );
    }
}

#[test]
fn initialize_accepts_exactly_the_usdc_scale() {
    let env = Env::default();
    let market = bare_market(&env);
    let token = env.register(scaled_token::ScaledToken, (USDC_DECIMALS,));
    assert_eq!(try_init(&market, &token), Ok(()));
    assert_eq!(market.get_usdc(), token);
}

#[test]
fn a_rejected_initialize_leaves_the_market_initializable() {
    let env = Env::default();
    let market = bare_market(&env);

    let wrong = env.register(scaled_token::ScaledToken, (6u32,));
    assert_eq!(try_init(&market, &wrong), Err(Error::UnsupportedDecimals));

    // The rejection consumed nothing: the right token still initializes.
    let sac = env
        .register_stellar_asset_contract_v2(Address::generate(&env))
        .address();
    assert_eq!(try_init(&market, &sac), Ok(()));
    assert_eq!(market.get_usdc(), sac);
}

#[test]
fn initialize_rejects_a_token_that_cannot_report_its_scale() {
    let env = Env::default();
    let market = bare_market(&env);

    // A contract without `decimals()`.
    let no_decimals = env.register(no_decimals_token::NoDecimalsToken, ());
    assert_eq!(
        try_init(&market, &no_decimals),
        Err(Error::UnsupportedToken)
    );

    // An address with no contract behind it at all.
    let nothing = Address::generate(&env);
    assert_eq!(try_init(&market, &nothing), Err(Error::UnsupportedToken));

    assert_eq!(
        market.try_get_usdc().unwrap_err().unwrap(),
        Error::NotInitialized
    );
}

// ── Amounts are never rescaled ───────────────────────────────────────────────

/// Principal comes back to the stroop: nothing on the path rounds to whole USDC
/// or to a coarser scale.
#[test]
fn single_stroop_precision_survives_a_full_refund() {
    let f = Fixture::new(700, 300);
    let creator_stake = MIN_STAKE + 1;
    let creator = f.user(creator_stake);
    let id = f.client().create_claim(&creator, &f.params(creator_stake));

    let stakes = [MIN_STAKE + 1, MIN_STAKE + 3, MIN_STAKE + 9];
    let mut challengers = std::vec::Vec::new();
    for stake in stakes {
        let who = f.user(stake);
        f.client().challenge_claim(&who, &id, &stake, &None);
        challengers.push((who, stake));
    }

    f.advance_by(3_600);
    f.client()
        .resolve_claim(&id, &WinnerSide::Draw, &f.str("draw"), &50, &f.zero_hash());
    f.settle_all_challengers(id);

    assert_eq!(f.token().balance(&creator), creator_stake);
    for (who, stake) in challengers.iter() {
        assert_eq!(f.token().balance(who), *stake);
    }
    assert_eq!(f.escrow_balance(), 0);
}

// ── Amounts at the i64 ceiling ───────────────────────────────────────────────

/// Every verdict and odds mode, with the whole escrow at exactly i64::MAX stroops
/// (~922 billion USDC) and fees at the cap. A classic Stellar account cannot hold
/// more than i64::MAX of an asset, so no single participant can stake beyond
/// this. The i128 products settlement forms (`stake * bps`,
/// `challenger_stake * creator_stake`) must still fit: no `Overflow`, and
/// conservation to the stroop.
#[test]
fn stakes_at_the_i64_ceiling_settle_exactly_without_overflow() {
    // 2^62 against two odd challenger stakes whose total fills the escrow to
    // exactly i64::MAX. The challengers' total is below the creator's stake, so a
    // fixed-odds 2x market is fully covered.
    let creator_stake: i128 = 1 << 62;
    let c1_stake: i128 = (1 << 61) + 7;
    let c2_stake: i128 = i64::MAX as i128 - creator_stake - c1_stake;
    assert!(c1_stake + c2_stake <= creator_stake);

    for verdict in [
        WinnerSide::Creator,
        WinnerSide::Challengers,
        WinnerSide::Draw,
        WinnerSide::Unresolvable,
    ] {
        for odds in ["pool", "fixed"] {
            let f = Fixture::new(700, 300); // the 10% cap
            let agent = f.user(0);
            let creator = f.user(creator_stake);
            let mut params = f.params(creator_stake);
            params.odds_mode = String::from_str(&f.env, odds);
            params.challenger_payout_bps = 20_000;
            params.agent_owner_recipient = Some(agent.clone());
            let id = f.client().create_claim(&creator, &params);

            let c1 = f.user(c1_stake);
            let c2 = f.user(c2_stake);
            f.client().challenge_claim(&c1, &id, &c1_stake, &None);
            f.client().challenge_claim(&c2, &id, &c2_stake, &None);
            assert_eq!(f.escrow_balance(), i64::MAX as i128);

            f.advance_by(3_600);
            f.client()
                .resolve_claim(&id, &verdict, &f.str("verdict"), &90, &f.zero_hash());
            if verdict != WinnerSide::Creator {
                f.settle_all_challengers(id);
            }

            // Everything paid out is still exact once fees are collected: the
            // escrow drains to zero, not to a rounding remainder.
            let mut fees = 0;
            for recipient in [&f.platform, &agent] {
                if f.client().get_accrued_fees(recipient) > 0 {
                    fees += f.client().claim_fees(recipient);
                }
            }
            let paid: i128 = [&creator, &c1, &c2]
                .iter()
                .map(|who| f.token().balance(who) + f.client().get_withdrawable(who))
                .sum();
            assert_eq!(
                paid + fees,
                i64::MAX as i128,
                "{verdict:?}/{odds}: paid {paid} + fees {fees}"
            );
            assert_eq!(f.escrow_balance(), 0, "{verdict:?}/{odds}");
        }
    }
}
