#![cfg(test)]
//! Shared test fixture: a registered market, a USDC Stellar Asset Contract, and
//! a stub token whose transfers can be made to fail on demand.

extern crate std;

use soroban_sdk::testutils::{Address as _, Ledger};
use soroban_sdk::token::{StellarAssetClient, TokenClient};
use soroban_sdk::{Address, BytesN, Env, String};

use crate::contract::{MimirMarket, MimirMarketClient};
use crate::types::CreateParams;

/// One whole USDC in atomic units at the 7 decimals a Stellar Asset Contract
/// exposes for a classic asset.
pub const USDC: i128 = 10_000_000;

pub const START_TIME: u64 = 1_700_000_000;

pub struct Fixture {
    pub env: Env,
    pub contract_id: Address,
    pub token_id: Address,
    pub owner: Address,
    pub oracle: Address,
    pub platform: Address,
    pub stub_backed: bool,
}

impl Fixture {
    /// Fixture backed by a real Stellar Asset Contract.
    pub fn new(platform_fee_bps: u32, agent_owner_fee_bps: u32) -> Self {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|li| li.timestamp = START_TIME);

        let sac = env.register_stellar_asset_contract_v2(Address::generate(&env));
        let token_id = sac.address();

        Self::wire(
            env,
            token_id,
            false,
            platform_fee_bps,
            agent_owner_fee_bps,
        )
    }

    /// Fixture backed by the stub token, for failure-path tests.
    pub fn with_stub_token(platform_fee_bps: u32, agent_owner_fee_bps: u32) -> Self {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|li| li.timestamp = START_TIME);

        let token_id = env.register(stub_token::StubToken, ());

        Self::wire(
            env,
            token_id,
            true,
            platform_fee_bps,
            agent_owner_fee_bps,
        )
    }

    fn wire(
        env: Env,
        token_id: Address,
        stub_backed: bool,
        platform_fee_bps: u32,
        agent_owner_fee_bps: u32,
    ) -> Self {
        let owner = Address::generate(&env);
        let oracle = Address::generate(&env);
        let platform = Address::generate(&env);
        let contract_id = env.register(MimirMarket, ());

        MimirMarketClient::new(&env, &contract_id).initialize(
            &owner,
            &oracle,
            &token_id,
            &platform_fee_bps,
            &agent_owner_fee_bps,
            &Some(platform.clone()),
        );

        Fixture {
            env,
            contract_id,
            token_id,
            owner,
            oracle,
            platform,
            stub_backed,
        }
    }

    pub fn client(&self) -> MimirMarketClient<'_> {
        MimirMarketClient::new(&self.env, &self.contract_id)
    }

    pub fn token(&self) -> TokenClient<'_> {
        TokenClient::new(&self.env, &self.token_id)
    }

    pub fn stub(&self) -> stub_token::StubTokenClient<'_> {
        stub_token::StubTokenClient::new(&self.env, &self.token_id)
    }

    /// Mint through whichever token backs this fixture.
    pub fn mint(&self, to: &Address, amount: i128) {
        if self.stub_backed {
            self.stub().mint(to, &amount);
        } else {
            StellarAssetClient::new(&self.env, &self.token_id).mint(to, &amount);
        }
    }

    /// A funded participant.
    pub fn user(&self, funding: i128) -> Address {
        let who = Address::generate(&self.env);
        self.mint(&who, funding);
        who
    }

    pub fn escrow_balance(&self) -> i128 {
        self.token().balance(&self.contract_id)
    }

    /// Settle every challenger on the roster, in roster order. Returns the total
    /// net credited. Settlement is pull-based and one call per challenger, so
    /// this is what a client or keeper would do after resolution.
    pub fn settle_all_challengers(&self, claim_id: u64) -> i128 {
        let mut total = 0;
        for entry in self.client().get_challenger_list(&claim_id).iter() {
            total += self
                .client()
                .claim_challenger_payout(&entry.address, &claim_id);
        }
        total
    }

    pub fn advance_to(&self, timestamp: u64) {
        self.env.ledger().with_mut(|li| li.timestamp = timestamp);
    }

    pub fn advance_by(&self, seconds: u64) {
        let now = self.env.ledger().timestamp();
        self.advance_to(now + seconds);
    }

    pub fn str(&self, s: &str) -> String {
        String::from_str(&self.env, s)
    }

    pub fn zero_hash(&self) -> BytesN<32> {
        BytesN::from_array(&self.env, &[0u8; 32])
    }

    /// Pool-mode, public, 100-slot market with a 1-hour deadline.
    pub fn params(&self, stake: i128) -> CreateParams {
        CreateParams {
            question: self.str("Will it rain?"),
            creator_position: self.str("yes"),
            counter_position: self.str("no"),
            resolution_url: self.str("https://example.test/evidence"),
            deadline: self.env.ledger().timestamp() + 3_600,
            stake_amount: stake,
            category: self.str("weather"),
            parent_id: 0,
            market_type: self.str("binary"),
            odds_mode: self.str("pool"),
            challenger_payout_bps: 0,
            handicap_line: self.str(""),
            settlement_rule: self.str("first-source"),
            max_challengers: 0,
            is_private: false,
            invite_key: None,
            context_hash: self.zero_hash(),
            agent_owner_recipient: None,
        }
    }
}

/// A deliberately minimal token. Implements only the entry points the market
/// actually calls (`decimals`, `balance`, `transfer`) plus test controls, so that
/// transfer failure and non-exact transfer can both be provoked.
pub mod stub_token {
    use soroban_sdk::{contract, contracterror, contractimpl, contracttype, Address, Env, Map};

    #[contracterror]
    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    #[repr(u32)]
    pub enum StubError {
        RecipientBlocked = 1,
        InsufficientBalance = 2,
    }

    #[contracttype]
    pub enum Key {
        Balances,
        Blocked,
        /// Basis points skimmed on transfer, to imitate a fee-on-transfer asset.
        SkimBps,
    }

    #[contract]
    pub struct StubToken;

    #[contractimpl]
    impl StubToken {
        pub fn is_stub(_env: Env) -> bool {
            true
        }

        /// USDC's scale, so the stub passes the `initialize` decimals check.
        pub fn decimals(_env: Env) -> u32 {
            crate::types::USDC_DECIMALS
        }

        pub fn mint(env: Env, to: Address, amount: i128) {
            let mut balances = balances(&env);
            let next = balances.get(to.clone()).unwrap_or(0) + amount;
            balances.set(to, next);
            env.storage().instance().set(&Key::Balances, &balances);
        }

        pub fn balance(env: Env, id: Address) -> i128 {
            balances(&env).get(id).unwrap_or(0)
        }

        pub fn transfer(
            env: Env,
            from: Address,
            to: Address,
            amount: i128,
        ) -> Result<(), StubError> {
            from.require_auth();
            if blocked(&env, &to) {
                return Err(StubError::RecipientBlocked);
            }
            let mut balances = balances(&env);
            let from_balance = balances.get(from.clone()).unwrap_or(0);
            if from_balance < amount {
                return Err(StubError::InsufficientBalance);
            }
            let skim_bps: i128 = env.storage().instance().get(&Key::SkimBps).unwrap_or(0);
            let credited = amount - (amount * skim_bps) / 10_000;
            balances.set(from, from_balance - amount);
            let to_balance = balances.get(to.clone()).unwrap_or(0);
            balances.set(to, to_balance + credited);
            env.storage().instance().set(&Key::Balances, &balances);
            Ok(())
        }

        pub fn set_blocked(env: Env, who: Address, value: bool) {
            let mut blocked: Map<Address, bool> = env
                .storage()
                .instance()
                .get(&Key::Blocked)
                .unwrap_or(Map::new(&env));
            blocked.set(who, value);
            env.storage().instance().set(&Key::Blocked, &blocked);
        }

        pub fn set_skim_bps(env: Env, bps: i128) {
            env.storage().instance().set(&Key::SkimBps, &bps);
        }
    }

    fn balances(env: &Env) -> Map<Address, i128> {
        env.storage()
            .instance()
            .get(&Key::Balances)
            .unwrap_or(Map::new(env))
    }

    fn blocked(env: &Env, who: &Address) -> bool {
        env.storage()
            .instance()
            .get::<_, Map<Address, bool>>(&Key::Blocked)
            .and_then(|m| m.get(who.clone()))
            .unwrap_or(false)
    }
}
