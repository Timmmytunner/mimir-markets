//! Public contract surface. Bodies live in `admin`, `claims` and `resolve`; this
//! file is the single `#[contractimpl]` block plus the read-only views.

use soroban_sdk::{contract, contractimpl, Address, BytesN, Env, String, Vec};

use crate::admin;
use crate::claims;
use crate::escrow;
use crate::resolve;
use crate::storage;
use crate::types::{
    Challenger, ChallengerPage, Claim, ClaimFeeView, CreateParams, Error, FeePolicy, MarketConfig,
    PayoutQuote, PendingFeePolicy, PlatformStats, Verdict, WinnerSide,
};

#[contract]
pub struct MimirMarket;

#[contractimpl]
impl MimirMarket {
    // ── Init & admin ─────────────────────────────────────────────────────────

    /// Constructor equivalent, callable once.
    pub fn initialize(
        env: Env,
        owner: Address,
        oracle: Address,
        usdc_token: Address,
        platform_fee_bps: u32,
        agent_owner_fee_bps: u32,
        platform_recipient: Option<Address>,
    ) -> Result<(), Error> {
        admin::initialize(
            &env,
            owner,
            oracle,
            usdc_token,
            platform_fee_bps,
            agent_owner_fee_bps,
            platform_recipient,
        )
    }

    pub fn set_oracle(env: Env, new_oracle: Address) -> Result<(), Error> {
        admin::set_oracle(&env, new_oracle)
    }

    pub fn transfer_ownership(env: Env, new_owner: Address) -> Result<(), Error> {
        admin::transfer_ownership(&env, new_owner)
    }

    pub fn queue_fee_policy(
        env: Env,
        platform_fee_bps: u32,
        agent_owner_fee_bps: u32,
        platform_recipient: Option<Address>,
    ) -> Result<(), Error> {
        admin::queue_fee_policy(
            &env,
            platform_fee_bps,
            agent_owner_fee_bps,
            platform_recipient,
        )
    }

    pub fn cancel_fee_policy(env: Env) -> Result<(), Error> {
        admin::cancel_fee_policy(&env)
    }

    /// Permissionless once the timelock has elapsed.
    pub fn execute_fee_policy(env: Env) -> Result<(), Error> {
        admin::execute_fee_policy(&env)
    }

    // ── Claim lifecycle ──────────────────────────────────────────────────────

    pub fn create_claim(env: Env, creator: Address, params: CreateParams) -> Result<u64, Error> {
        claims::create_claim(&env, creator, params)
    }

    pub fn challenge_claim(
        env: Env,
        challenger: Address,
        claim_id: u64,
        stake_amount: i128,
        invite_key: Option<String>,
    ) -> Result<(), Error> {
        claims::challenge_claim(&env, challenger, claim_id, stake_amount, invite_key)
    }

    pub fn resolve_claim(
        env: Env,
        claim_id: u64,
        winner_side: WinnerSide,
        summary: String,
        confidence: u32,
        evidence_hash: BytesN<32>,
    ) -> Result<(), Error> {
        resolve::resolve_claim(&env, claim_id, winner_side, summary, confidence, evidence_hash)
    }

    /// Versioned verdict entry point. Identical settlement semantics to
    /// `resolve_claim`, but the oracle submits a `Verdict` carrying its explicit
    /// encoding version. Unknown versions are refused with
    /// `Error::UnsupportedVerdictVersion` and leave the claim untouched.
    pub fn resolve_claim_versioned(
        env: Env,
        claim_id: u64,
        verdict: Verdict,
        summary: String,
        confidence: u32,
        evidence_hash: BytesN<32>,
    ) -> Result<(), Error> {
        resolve::resolve_claim_versioned(
            &env,
            claim_id,
            &verdict,
            summary,
            confidence,
            evidence_hash,
        )
    }

    
    pub fn transition_deadline(env: Env, claim_id: u64) -> Result<(), Error> {
        claims::transition_deadline(&env, claim_id)
    }

    pub fn cancel_claim(env: Env, claim_id: u64) -> Result<(), Error> {
        claims::cancel_claim(&env, claim_id)
    }

    /// Settle one challenger's winning or refunded position. Callable once per
    /// challenger after resolution, and O(1) in the number of challengers, so a
    /// market filled to MAX_CHALLENGERS can always be paid out in full.
    ///
    /// `resolve_claim` deliberately does NOT loop over challengers: a Stellar
    /// transaction is capped on its ledger-entry footprint, and paying ~100
    /// challengers at once does not fit. Returns the net amount credited.
    pub fn claim_challenger_payout(
        env: Env,
        challenger: Address,
        claim_id: u64,
    ) -> Result<i128, Error> {
        resolve::claim_challenger_payout(&env, challenger, claim_id)
    }

    // ── Pull payments ────────────────────────────────────────────────────────

    /// Solidity used `msg.sender`; Soroban has no equivalent for a top-level
    /// call, so the beneficiary is an explicit argument that must authorize.
    pub fn withdraw(env: Env, who: Address) -> Result<i128, Error> {
        resolve::withdraw(&env, who)
    }

    pub fn claim_fees(env: Env, who: Address) -> Result<i128, Error> {
        resolve::claim_fees(&env, who)
    }

    // ── Views ────────────────────────────────────────────────────────────────

    pub fn get_claim(env: Env, claim_id: u64) -> Result<Claim, Error> {
        storage::get_claim(&env, claim_id)
    }

    /// The claim's verdict with its explicit encoding version.
    ///
    /// Refuses with `Error::UnsupportedVerdictVersion` if the stored verdict was
    /// written by an encoding this contract does not understand, and with
    /// `Error::ClaimNotResolved` if the claim has not been resolved.
    pub fn get_verdict(env: Env, claim_id: u64) -> Result<Verdict, Error> {
        resolve::get_verdict(&env, claim_id)
    }

    /// Convenience view returning only the decoded verdict side.
    pub fn get_verdict_side(env: Env, claim_id: u64) -> Result<WinnerSide, Error> {
        resolve::get_verdict(&env, claim_id)?.decode()
    }

    pub fn get_claim_market_config(env: Env, claim_id: u64) -> Result<MarketConfig, Error> {
        Ok(storage::get_claim(&env, claim_id)?.market)
    }

    pub fn get_claim_fees(env: Env, claim_id: u64) -> Result<ClaimFeeView, Error> {
        let claim = storage::get_claim(&env, claim_id)?;
        Ok(ClaimFeeView {
            platform_fee_bps: claim.fees.platform_fee_bps,
            agent_owner_fee_bps: claim.fees.agent_owner_fee_bps,
            platform_recipient: claim.fees.platform_recipient,
            agent_owner_recipient: claim.fees.agent_owner_recipient,
            context_hash: claim.context_hash,
        })
    }

    /// The roster, including each challenger's stake and whether they have
    /// already pulled their settlement.
    pub fn get_challenger_list(env: Env, claim_id: u64) -> Vec<Challenger> {
        storage::challengers(&env, claim_id)
    }

    /// A paginated window into the challenger roster.
    ///
    /// Returns up to `limit` entries starting at `offset` (0-based).  
    /// `limit = 0` returns all entries from `offset` to the end of the roster —
    /// identical to `get_challenger_list` when `offset = 0`.
    ///
    /// The `ChallengerPage` response always carries `total` (full roster length)
    /// so callers can detect the last page without issuing an extra empty fetch.
    ///
    /// Neither `offset` nor `limit` can cause a panic: an `offset` beyond the
    /// end of the roster returns an empty `items` slice with `total` set
    /// correctly.
    pub fn get_challengers_page(
        env: Env,
        claim_id: u64,
        offset: u32,
        limit: u32,
    ) -> ChallengerPage {
        storage::challengers_page(&env, claim_id, offset, limit)
    }

    /// What `claim_challenger_payout` would pay this challenger right now.
    pub fn quote_challenger_payout(
        env: Env,
        claim_id: u64,
        challenger: Address,
    ) -> Result<PayoutQuote, Error> {
        resolve::quote_challenger_payout(&env, claim_id, &challenger)
    }

    pub fn get_platform_stats(env: Env) -> Result<PlatformStats, Error> {
        let usdc = storage::usdc(&env)?;
        Ok(PlatformStats {
            total_claims: storage::claim_count(&env),
            resolved: storage::total_resolved(&env),
            balance: escrow::balance(&env, &usdc),
            fees_accrued: storage::lifetime_fees_accrued(&env),
            fees_claimed: storage::lifetime_fees_claimed(&env),
        })
    }

    pub fn get_fee_policy(env: Env) -> Result<FeePolicy, Error> {
        storage::fee_policy(&env)
    }

    pub fn get_pending_fee_policy(env: Env) -> Option<PendingFeePolicy> {
        storage::pending_fee_policy(&env)
    }

    pub fn get_owner(env: Env) -> Result<Address, Error> {
        storage::owner(&env)
    }

    pub fn get_oracle(env: Env) -> Result<Address, Error> {
        storage::oracle(&env)
    }

    pub fn get_usdc(env: Env) -> Result<Address, Error> {
        storage::usdc(&env)
    }

    pub fn get_withdrawable(env: Env, who: Address) -> i128 {
        storage::withdrawable(&env, &who)
    }

    pub fn get_accrued_fees(env: Env, who: Address) -> i128 {
        storage::accrued_fees(&env, &who)
    }
}
