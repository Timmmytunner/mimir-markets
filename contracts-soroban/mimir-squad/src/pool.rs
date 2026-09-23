//! Market lifecycle: create, deposit, withdraw, resolve, claim.

use soroban_sdk::{Address, Env, String};

use crate::escrow;
use crate::events;
use crate::storage;
use crate::types::{
    ClaimResult, Error, Market, BPS_DIVISOR, MAX_DURATION, MAX_FEE_BPS, MAX_PARTICIPANTS_PER_SIDE,
    MIN_DURATION, RESULT_CANCELLED, SIDE_A, SIDE_B,
};

fn require_side(side: u32) -> Result<(), Error> {
    if side != SIDE_A && side != SIDE_B {
        return Err(Error::BadSide);
    }
    Ok(())
}

pub fn initialize(
    env: &Env,
    usdc: Address,
    oracle: Address,
    fee_recipient: Address,
) -> Result<(), Error> {
    if storage::is_initialized(env) {
        return Err(Error::AlreadyInitialized);
    }
    escrow::require_usdc_decimals(env, &usdc)?;
    storage::mark_initialized(env);
    storage::set_config(env, &usdc, &oracle, &fee_recipient);
    Ok(())
}

pub fn create_market(
    env: &Env,
    captain: Address,
    question: String,
    deadline: u64,
    fee_bps: u32,
) -> Result<u64, Error> {
    captain.require_auth();

    if question.is_empty() {
        return Err(Error::EmptyQuestion);
    }
    let now = env.ledger().timestamp();
    let earliest = now.checked_add(MIN_DURATION).ok_or(Error::Overflow)?;
    let latest = now.checked_add(MAX_DURATION).ok_or(Error::Overflow)?;
    if deadline < earliest || deadline > latest {
        return Err(Error::BadDeadline);
    }
    if fee_bps > MAX_FEE_BPS {
        return Err(Error::FeeCapExceeded);
    }

    let id = storage::market_count(env) + 1;
    storage::set_market_count(env, id);
    storage::set_market(
        env,
        id,
        &Market {
            captain: captain.clone(),
            deadline,
            fee_bps,
            result: 0,
            resolved: false,
            pool_a: 0,
            pool_b: 0,
            remaining_escrow: 0,
            participants_a: 0,
            participants_b: 0,
            winner_claims: 0,
        },
    );

    events::MarketCreated {
        market_id: id,
        captain,
        deadline,
        fee_bps,
        question,
    }
    .publish(env);
    Ok(id)
}

pub fn deposit(
    env: &Env,
    participant: Address,
    market_id: u64,
    side: u32,
    amount: i128,
) -> Result<(), Error> {
    participant.require_auth();

    let mut market = storage::get_market(env, market_id)?;
    if market.resolved || env.ledger().timestamp() >= market.deadline {
        return Err(Error::MarketClosed);
    }
    require_side(side)?;
    if amount <= 0 {
        return Err(Error::ZeroAmount);
    }

    // The participant count only moves on a NEW depositor to that side, so
    // topping up an existing position never consumes a slot.
    let previous = storage::deposit_of(env, market_id, side, &participant);
    if previous == 0 {
        let count = if side == SIDE_A {
            market.participants_a
        } else {
            market.participants_b
        };
        if count >= MAX_PARTICIPANTS_PER_SIDE {
            return Err(Error::SideFull);
        }
        if side == SIDE_A {
            market.participants_a += 1;
        } else {
            market.participants_b += 1;
        }
    }

    let usdc = storage::usdc(env)?;
    escrow::pull(env, &usdc, &participant, amount)?;

    storage::set_deposit(env, market_id, side, &participant, previous + amount);
    if side == SIDE_A {
        market.pool_a += amount;
    } else {
        market.pool_b += amount;
    }
    storage::set_market(env, market_id, &market);

    events::Deposited {
        market_id,
        side,
        participant,
        amount,
        shares: amount, // shares equal deposited units
    }
    .publish(env);
    Ok(())
}

pub fn withdraw_before_deadline(
    env: &Env,
    participant: Address,
    market_id: u64,
    side: u32,
    amount: i128,
) -> Result<(), Error> {
    participant.require_auth();
    require_side(side)?;

    let mut market = storage::get_market(env, market_id)?;
    if market.resolved || env.ledger().timestamp() >= market.deadline {
        return Err(Error::Locked);
    }

    let balance = storage::deposit_of(env, market_id, side, &participant);
    if amount <= 0 || amount > balance {
        return Err(Error::BadAmount);
    }

    let next = balance - amount;
    storage::set_deposit(env, market_id, side, &participant, next);
    if side == SIDE_A {
        market.pool_a -= amount;
        if next == 0 {
            market.participants_a -= 1;
        }
    } else {
        market.pool_b -= amount;
        if next == 0 {
            market.participants_b -= 1;
        }
    }
    storage::set_market(env, market_id, &market);

    let usdc = storage::usdc(env)?;
    escrow::push(env, &usdc, &participant, amount);

    events::Withdrawn {
        market_id,
        side,
        participant,
        amount,
    }
    .publish(env);
    Ok(())
}

pub fn resolve(env: &Env, market_id: u64, result: u32) -> Result<(), Error> {
    storage::oracle(env)?.require_auth();

    let mut market = storage::get_market(env, market_id)?;
    if market.resolved || env.ledger().timestamp() < market.deadline {
        return Err(Error::NotResolvable);
    }
    if result != SIDE_A && result != SIDE_B && result != RESULT_CANCELLED {
        return Err(Error::BadResult);
    }
    if result != RESULT_CANCELLED {
        let winner_pool = if result == SIDE_A {
            market.pool_a
        } else {
            market.pool_b
        };
        if winner_pool <= 0 {
            return Err(Error::EmptyWinner);
        }
    }

    market.resolved = true;
    market.result = result;
    market.remaining_escrow = market.pool_a + market.pool_b;
    storage::set_market(env, market_id, &market);

    events::Resolved {
        market_id,
        result,
        pool_a: market.pool_a,
        pool_b: market.pool_b,
    }
    .publish(env);
    Ok(())
}

pub fn claim(
    env: &Env,
    participant: Address,
    market_id: u64,
    side: u32,
) -> Result<i128, Error> {
    participant.require_auth();
    require_side(side)?;

    let mut market = storage::get_market(env, market_id)?;
    if !market.resolved {
        return Err(Error::NotClaimable);
    }
    if storage::has_claimed(env, market_id, side, &participant) {
        return Err(Error::AlreadyClaimed);
    }

    let principal = storage::deposit_of(env, market_id, side, &participant);
    if principal <= 0 {
        return Err(Error::NotWinner);
    }
    if market.result != RESULT_CANCELLED && side != market.result {
        return Err(Error::NotWinner);
    }

    storage::mark_claimed(env, market_id, side, &participant);

    let mut gross = principal;
    let mut fee = 0i128;

    if market.result != RESULT_CANCELLED {
        let winner_pool = if market.result == SIDE_A {
            market.pool_a
        } else {
            market.pool_b
        };
        let winner_count = if market.result == SIDE_A {
            market.participants_a
        } else {
            market.participants_b
        };

        market.winner_claims += 1;
        gross = if market.winner_claims == winner_count {
            // The last winner to claim absorbs whatever is left, so truncation
            // dust cannot be stranded in escrow.
            market.remaining_escrow
        } else {
            (market.pool_a + market.pool_b)
                .checked_mul(principal)
                .map(|p| p / winner_pool)
                .ok_or(Error::Overflow)?
        };

        // Fees apply to PROFIT only, so a winner never receives less than their
        // principal.
        let profit = if gross > principal { gross - principal } else { 0 };
        fee = profit
            .checked_mul(market.fee_bps as i128)
            .map(|p| p / BPS_DIVISOR)
            .ok_or(Error::Overflow)?;
    }

    market.remaining_escrow -= gross;
    storage::set_market(env, market_id, &market);

    let net = gross - fee;
    storage::set_accrued_fees(env, storage::accrued_fees(env) + fee);

    let usdc = storage::usdc(env)?;
    escrow::push(env, &usdc, &participant, net);

    events::Claimed {
        market_id,
        participant,
        gross,
        fee,
        net,
    }
    .publish(env);
    Ok(net)
}

pub fn claim_fees(env: &Env) -> Result<i128, Error> {
    let recipient = storage::fee_recipient(env)?;
    recipient.require_auth();

    let amount = storage::accrued_fees(env);
    if amount <= 0 {
        return Err(Error::NoFees);
    }
    storage::set_accrued_fees(env, 0); // effects before interaction

    let usdc = storage::usdc(env)?;
    escrow::push(env, &usdc, &recipient, amount);

    events::FeesClaimed {
        recipient,
        amount,
    }
    .publish(env);
    Ok(amount)
}

/// Split of a claim, without performing it. Useful for UI previews.
pub fn preview_claim(
    env: &Env,
    market_id: u64,
    side: u32,
    participant: &Address,
) -> Result<ClaimResult, Error> {
    let market = storage::get_market(env, market_id)?;
    let principal = storage::deposit_of(env, market_id, side, participant);
    if !market.resolved || principal <= 0 {
        return Ok(ClaimResult {
            gross: 0,
            fee: 0,
            net: 0,
        });
    }
    if market.result != RESULT_CANCELLED && side != market.result {
        return Ok(ClaimResult {
            gross: 0,
            fee: 0,
            net: 0,
        });
    }
    if market.result == RESULT_CANCELLED {
        return Ok(ClaimResult {
            gross: principal,
            fee: 0,
            net: principal,
        });
    }

    let winner_pool = if market.result == SIDE_A {
        market.pool_a
    } else {
        market.pool_b
    };
    let winner_count = if market.result == SIDE_A {
        market.participants_a
    } else {
        market.participants_b
    };
    let gross = if market.winner_claims + 1 == winner_count {
        market.remaining_escrow
    } else {
        (market.pool_a + market.pool_b)
            .checked_mul(principal)
            .map(|p| p / winner_pool)
            .ok_or(Error::Overflow)?
    };
    let profit = if gross > principal { gross - principal } else { 0 };
    let fee = profit
        .checked_mul(market.fee_bps as i128)
        .map(|p| p / BPS_DIVISOR)
        .ok_or(Error::Overflow)?;
    Ok(ClaimResult {
        gross,
        fee,
        net: gross - fee,
    })
}
