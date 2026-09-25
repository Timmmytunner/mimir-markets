//! Public contract surface. Bodies live in `pool`; this file is the single
//! `#[contractimpl]` block plus the read-only views.

use soroban_sdk::{contract, contractimpl, Address, Env, String};

use crate::escrow;
use crate::pool;
use crate::storage;
use crate::types::{ClaimResult, Error, Market};

#[contract]
pub struct MimirSquad;

#[contractimpl]
impl MimirSquad {
    /// Constructor equivalent, callable once.
    pub fn initialize(
        env: Env,
        usdc: Address,
        oracle: Address,
        fee_recipient: Address,
    ) -> Result<(), Error> {
        pool::initialize(&env, usdc, oracle, fee_recipient)
    }

    pub fn create_market(
        env: Env,
        captain: Address,
        question: String,
        deadline: u64,
        fee_bps: u32,
    ) -> Result<u64, Error> {
        pool::create_market(&env, captain, question, deadline, fee_bps)
    }

    pub fn deposit(
        env: Env,
        participant: Address,
        market_id: u64,
        side: u32,
        amount: i128,
    ) -> Result<(), Error> {
        pool::deposit(&env, participant, market_id, side, amount)
    }

    pub fn withdraw_before_deadline(
        env: Env,
        participant: Address,
        market_id: u64,
        side: u32,
        amount: i128,
    ) -> Result<(), Error> {
        pool::withdraw_before_deadline(&env, participant, market_id, side, amount)
    }

    
    pub fn transition_deadline(env: Env, market_id: u64) -> Result<(), Error> {
        pool::transition_deadline(&env, market_id)
    }

    pub fn resolve(env: Env, market_id: u64, result: u32) -> Result<(), Error> {
        pool::resolve(&env, market_id, result)
    }

    /// Pull-based payout. Solidity used `msg.sender`; Soroban has no equivalent
    /// for a top-level call, so the claimant is an explicit argument that must
    /// authorize. Returns the net amount transferred.
    pub fn claim(env: Env, participant: Address, market_id: u64, side: u32) -> Result<i128, Error> {
        pool::claim(&env, participant, market_id, side)
    }

    pub fn claim_fees(env: Env) -> Result<i128, Error> {
        pool::claim_fees(&env)
    }

    // ── Views ────────────────────────────────────────────────────────────────

    pub fn get_market(env: Env, market_id: u64) -> Result<Market, Error> {
        storage::get_market(&env, market_id)
    }

    pub fn get_deposit(env: Env, market_id: u64, side: u32, who: Address) -> i128 {
        storage::deposit_of(&env, market_id, side, &who)
    }

    pub fn has_claimed(env: Env, market_id: u64, side: u32, who: Address) -> bool {
        storage::has_claimed(&env, market_id, side, &who)
    }

    pub fn preview_claim(
        env: Env,
        market_id: u64,
        side: u32,
        who: Address,
    ) -> Result<ClaimResult, Error> {
        pool::preview_claim(&env, market_id, side, &who)
    }

    pub fn get_market_count(env: Env) -> u64 {
        storage::market_count(&env)
    }

    pub fn get_accrued_fees(env: Env) -> i128 {
        storage::accrued_fees(&env)
    }

    pub fn get_usdc(env: Env) -> Result<Address, Error> {
        storage::usdc(&env)
    }

    pub fn get_oracle(env: Env) -> Result<Address, Error> {
        storage::oracle(&env)
    }

    pub fn get_fee_recipient(env: Env) -> Result<Address, Error> {
        storage::fee_recipient(&env)
    }

    pub fn get_escrow_balance(env: Env) -> Result<i128, Error> {
        let usdc = storage::usdc(&env)?;
        Ok(escrow::balance(&env, &usdc))
    }
}
