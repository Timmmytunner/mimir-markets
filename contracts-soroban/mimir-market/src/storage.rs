//! Storage keys and typed accessors.
//!
//! Globals live in instance storage (small, always loaded with the contract).
//! Per-claim and per-address rows live in persistent storage.

use soroban_sdk::{contracttype, Address, Env, Vec};

use crate::types::{Challenger, Claim, Error, FeePolicy, PendingFeePolicy, Verdict};

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    /// One-time initialisation guard.
    Init,
    Owner,
    Oracle,
    Usdc,
    Policy,
    Pending,
    ClaimCount,
    TotalResolved,
    FeesAccrued,
    FeesClaimed,
    Claim(u64),
    Challengers(u64),
    /// Versioned verdict written at resolution. Absent on claims resolved
    /// before verdicts were versioned; readers fall back to `Claim.winner_side`
    /// for those.
    Verdict(u64),
    /// Pull-payment fallback for failed payout pushes.
    Withdrawable(Address),
    /// Accrued, unclaimed fees. Always pulled, never pushed.
    Accrued(Address),
}

/// Persistent entries are bumped to roughly 30 days of ledgers on touch so an
/// open market cannot be archived out from under its participants.
const BUMP_THRESHOLD: u32 = 120_960;
const BUMP_EXTEND: u32 = 518_400;

// ── Globals ──────────────────────────────────────────────────────────────────

pub fn is_initialized(env: &Env) -> bool {
    env.storage().instance().has(&DataKey::Init)
}

pub fn mark_initialized(env: &Env) {
    env.storage().instance().set(&DataKey::Init, &true);
}

pub fn owner(env: &Env) -> Result<Address, Error> {
    env.storage()
        .instance()
        .get(&DataKey::Owner)
        .ok_or(Error::NotInitialized)
}

pub fn set_owner(env: &Env, who: &Address) {
    env.storage().instance().set(&DataKey::Owner, who);
}

pub fn oracle(env: &Env) -> Result<Address, Error> {
    env.storage()
        .instance()
        .get(&DataKey::Oracle)
        .ok_or(Error::NotInitialized)
}

pub fn set_oracle(env: &Env, who: &Address) {
    env.storage().instance().set(&DataKey::Oracle, who);
}

pub fn usdc(env: &Env) -> Result<Address, Error> {
    env.storage()
        .instance()
        .get(&DataKey::Usdc)
        .ok_or(Error::NotInitialized)
}

pub fn set_usdc(env: &Env, who: &Address) {
    env.storage().instance().set(&DataKey::Usdc, who);
}

pub fn fee_policy(env: &Env) -> Result<FeePolicy, Error> {
    env.storage()
        .instance()
        .get(&DataKey::Policy)
        .ok_or(Error::NotInitialized)
}

pub fn set_fee_policy(env: &Env, policy: &FeePolicy) {
    env.storage().instance().set(&DataKey::Policy, policy);
}

pub fn pending_fee_policy(env: &Env) -> Option<PendingFeePolicy> {
    env.storage().instance().get(&DataKey::Pending)
}

pub fn set_pending_fee_policy(env: &Env, pending: &PendingFeePolicy) {
    env.storage().instance().set(&DataKey::Pending, pending);
}

pub fn clear_pending_fee_policy(env: &Env) {
    env.storage().instance().remove(&DataKey::Pending);
}

fn counter(env: &Env, key: DataKey) -> u64 {
    env.storage().instance().get(&key).unwrap_or(0)
}

fn set_counter(env: &Env, key: DataKey, value: u64) {
    env.storage().instance().set(&key, &value);
}

pub fn claim_count(env: &Env) -> u64 {
    counter(env, DataKey::ClaimCount)
}

pub fn set_claim_count(env: &Env, value: u64) {
    set_counter(env, DataKey::ClaimCount, value);
}

pub fn total_resolved(env: &Env) -> u64 {
    counter(env, DataKey::TotalResolved)
}

pub fn bump_total_resolved(env: &Env) {
    let next = total_resolved(env) + 1;
    set_counter(env, DataKey::TotalResolved, next);
}

fn amount(env: &Env, key: DataKey) -> i128 {
    env.storage().instance().get(&key).unwrap_or(0)
}

pub fn lifetime_fees_accrued(env: &Env) -> i128 {
    amount(env, DataKey::FeesAccrued)
}

pub fn add_lifetime_fees_accrued(env: &Env, delta: i128) {
    let next = lifetime_fees_accrued(env) + delta;
    env.storage().instance().set(&DataKey::FeesAccrued, &next);
}

pub fn lifetime_fees_claimed(env: &Env) -> i128 {
    amount(env, DataKey::FeesClaimed)
}

pub fn add_lifetime_fees_claimed(env: &Env, delta: i128) {
    let next = lifetime_fees_claimed(env) + delta;
    env.storage().instance().set(&DataKey::FeesClaimed, &next);
}

// ── Claims ───────────────────────────────────────────────────────────────────

pub fn get_claim(env: &Env, id: u64) -> Result<Claim, Error> {
    let key = DataKey::Claim(id);
    let claim: Claim = env
        .storage()
        .persistent()
        .get(&key)
        .ok_or(Error::ClaimNotFound)?;
    env.storage()
        .persistent()
        .extend_ttl(&key, BUMP_THRESHOLD, BUMP_EXTEND);
    Ok(claim)
}

pub fn set_claim(env: &Env, id: u64, claim: &Claim) {
    let key = DataKey::Claim(id);
    env.storage().persistent().set(&key, claim);
    env.storage()
        .persistent()
        .extend_ttl(&key, BUMP_THRESHOLD, BUMP_EXTEND);
}

pub fn challengers(env: &Env, id: u64) -> Vec<Challenger> {
    let key = DataKey::Challengers(id);
    match env.storage().persistent().get::<_, Vec<Challenger>>(&key) {
        Some(list) => {
            env.storage()
                .persistent()
                .extend_ttl(&key, BUMP_THRESHOLD, BUMP_EXTEND);
            list
        }
        None => Vec::new(env),
    }
}

/// Return a page of the challenger roster starting at `offset`, up to `limit`
/// entries. `limit = 0` is treated as "return all remaining entries from
/// `offset`". Callers should use a non-zero limit in production to bound
/// ledger-entry footprint.
///
/// Never panics: if `offset` is beyond the end of the roster the returned
/// `items` slice is empty and `total` carries the actual roster length.
pub fn challengers_page(
    env: &Env,
    id: u64,
    offset: u32,
    limit: u32,
) -> crate::types::ChallengerPage {
    let list = challengers(env, id);
    let total = list.len();

    // Clamp offset to [0, total] so arithmetic below is always valid.
    let start = offset.min(total);

    // How many items remain from `start` to the end of the roster.
    let remaining = total - start;

    // Effective limit: 0 means "everything remaining".
    let take = if limit == 0 {
        remaining
    } else {
        limit.min(remaining)
    };

    let mut items = Vec::new(env);
    for i in start..start + take {
        items.push_back(list.get(i).unwrap());
    }

    crate::types::ChallengerPage {
        items,
        offset: start,
        total,
    }
}

pub fn set_challengers(env: &Env, id: u64, list: &Vec<Challenger>) {
    let key = DataKey::Challengers(id);
    env.storage().persistent().set(&key, list);
    env.storage()
        .persistent()
        .extend_ttl(&key, BUMP_THRESHOLD, BUMP_EXTEND);
}

// ── Versioned verdicts ───────────────────────────────────────────────────────

/// The versioned verdict stored for a resolved claim, if one was written.
///
/// `None` is the pre-versioning case: the claim was resolved by a contract
/// build that stored only `Claim.winner_side`. Callers must fall back to that
/// field rather than treating the claim as unresolved.
pub fn verdict(env: &Env, id: u64) -> Option<Verdict> {
    let key = DataKey::Verdict(id);
    let stored: Option<Verdict> = env.storage().persistent().get(&key);
    if stored.is_some() {
        env.storage()
            .persistent()
            .extend_ttl(&key, BUMP_THRESHOLD, BUMP_EXTEND);
    }
    stored
}

pub fn set_verdict(env: &Env, id: u64, verdict: &Verdict) {
    let key = DataKey::Verdict(id);
    env.storage().persistent().set(&key, verdict);
    env.storage()
        .persistent()
        .extend_ttl(&key, BUMP_THRESHOLD, BUMP_EXTEND);
}

// ── Per-address rows ─────────────────────────────────────────────────────────

fn address_i128(env: &Env, key: DataKey) -> i128 {
    env.storage().persistent().get(&key).unwrap_or(0)
}

fn set_address_i128(env: &Env, key: DataKey, value: i128) {
    if value == 0 {
        env.storage().persistent().remove(&key);
        return;
    }
    env.storage().persistent().set(&key, &value);
    env.storage()
        .persistent()
        .extend_ttl(&key, BUMP_THRESHOLD, BUMP_EXTEND);
}

pub fn withdrawable(env: &Env, who: &Address) -> i128 {
    address_i128(env, DataKey::Withdrawable(who.clone()))
}

pub fn add_withdrawable(env: &Env, who: &Address, delta: i128) {
    let key = DataKey::Withdrawable(who.clone());
    let next = address_i128(env, key.clone()) + delta;
    set_address_i128(env, key, next);
}

pub fn clear_withdrawable(env: &Env, who: &Address) {
    set_address_i128(env, DataKey::Withdrawable(who.clone()), 0);
}

pub fn accrued_fees(env: &Env, who: &Address) -> i128 {
    address_i128(env, DataKey::Accrued(who.clone()))
}

pub fn add_accrued_fees(env: &Env, who: &Address, delta: i128) {
    let key = DataKey::Accrued(who.clone());
    let next = address_i128(env, key.clone()) + delta;
    set_address_i128(env, key, next);
}

pub fn clear_accrued_fees(env: &Env, who: &Address) {
    set_address_i128(env, DataKey::Accrued(who.clone()), 0);
}
