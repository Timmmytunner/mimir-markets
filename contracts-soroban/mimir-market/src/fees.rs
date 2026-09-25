//! Payout arithmetic. The mirror of this lives in `lib/fees.ts`.

use soroban_sdk::Env;

use crate::events;
use crate::storage;
use crate::types::{Error, FeeSnapshot, BPS_DIVISOR};

/// `stake * bps / BPS_DIVISOR`, truncating. Checked multiplication so an
/// absurd stake errors instead of wrapping, matching Solidity 0.8 revert-on-
/// overflow semantics.
pub fn gross_payout(stake: i128, bps: u32) -> Result<i128, Error> {
    stake
        .checked_mul(bps as i128)
        .map(|p| p / BPS_DIVISOR)
        .ok_or(Error::Overflow)
}

/// Pool-mode share of the creator's stake owed to one challenger:
/// `challenger_stake * creator_stake / total_challenger_stake`, truncating.
pub fn pool_share(
    challenger_stake: i128,
    creator_stake: i128,
    total_challenger_stake: i128,
) -> Result<i128, Error> {
    if total_challenger_stake == 0 {
        return Ok(0);
    }
    challenger_stake
        .checked_mul(creator_stake)
        .map(|p| p / total_challenger_stake)
        .ok_or(Error::Overflow)
}

/// The fee split for a gross payout, without accruing anything. Returns
/// `(owed, fees_taken)`.
///
/// A fee with no recipient is not charged. The init/queue guards already make
/// this unreachable for the platform fee; keeping it here means a malformed
/// snapshot can never mint an unclaimable balance.
pub fn quote_fees(principal: i128, gross: i128, fees: &FeeSnapshot) -> Result<(i128, i128), Error> {
    if gross <= principal {
        return Ok((gross, 0));
    }
    let profit = gross - principal;

    let platform_fee = match &fees.platform_recipient {
        Some(_) => bps_of(profit, fees.platform_fee_bps)?,
        None => 0,
    };
    let owner_fee = match &fees.agent_owner_recipient {
        Some(_) => bps_of(profit, fees.agent_owner_fee_bps)?,
        None => 0,
    };

    let fees_taken = platform_fee + owner_fee;
    Ok((gross - fees_taken, fees_taken))
}

fn bps_of(amount: i128, bps: u32) -> Result<i128, Error> {
    amount
        .checked_mul(bps as i128)
        .map(|p| p / BPS_DIVISOR)
        .ok_or(Error::Overflow)
}

/// Split a gross payout into fees and the amount owed.
///
/// Fees apply to PROFIT only, so `owed` can never fall below `principal` for a
/// winner. Each leg is `floor(profit * bps / BPS_DIVISOR)`, computed separately,
/// so every leg rounds DOWN and two legs together never take more than one leg
/// at their combined rate would. The fractional remainder stays with the
/// participant (`owed = gross - fees_taken`), so fee rounding leaves nothing in
/// escrow. Escrow dust comes only from pool-share truncation, and the last
/// claimant absorbs it.
///
/// Returns `(owed, fees_taken)` and accrues the fee balances as a side effect.
pub fn apply_fees(
    env: &Env,
    claim_id: u64,
    principal: i128,
    gross: i128,
    fees: &FeeSnapshot,
) -> Result<(i128, i128), Error> {
    let (owed, fees_taken) = quote_fees(principal, gross, fees)?;
    if fees_taken == 0 {
        return Ok((owed, 0));
    }

    let profit = gross - principal;
    let platform_fee = match &fees.platform_recipient {
        Some(_) => bps_of(profit, fees.platform_fee_bps)?,
        None => 0,
    };
    let owner_fee = fees_taken - platform_fee;

    if platform_fee > 0 {
        let to = fees.platform_recipient.clone().unwrap();
        storage::add_accrued_fees(env, &to, platform_fee);
        storage::add_lifetime_fees_accrued(env, platform_fee);
        events::FeeAccrued {
            id: claim_id,
            recipient: to,
            amount: platform_fee,
            is_agent_owner_fee: false,
        }
        .publish(env);
    }
    if owner_fee > 0 {
        let to = fees.agent_owner_recipient.clone().unwrap();
        storage::add_accrued_fees(env, &to, owner_fee);
        storage::add_lifetime_fees_accrued(env, owner_fee);
        events::FeeAccrued {
            id: claim_id,
            recipient: to,
            amount: owner_fee,
            is_agent_owner_fee: true,
        }
        .publish(env);
    }

    Ok((owed, fees_taken))
}
