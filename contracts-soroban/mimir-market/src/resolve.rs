//! Oracle settlement and payout distribution.
//!
//! DEVIATION FROM SOLIDITY (required for correctness on Soroban):
//! `MimirV2.resolveClaim` paid every challenger inside one transaction. A
//! Stellar transaction is capped not just on CPU but on its ledger-entry
//! FOOTPRINT (100 entries, 50 of them writes), and each challenger paid costs
//! entries. Past ~21 challengers a single settlement call cannot fit, so a market
//! filled toward MAX_CHALLENGERS = 100 could be resolved but never fully paid —
//! funds stranded.
//!
//! So settlement is split, mirroring `mimir-squad`:
//!   * `resolve_claim` is O(1). It records the verdict, pays the creator when the
//!     creator's leg is a single transfer, and leaves `remaining_escrow` as the
//!     amount still owed to challengers.
//!   * `claim_challenger_payout` is a per-challenger pull, O(1) each.
//!
//! Conservation is preserved and in fact tightened: `remaining_escrow` is drawn
//! down by every claim and the final claimant absorbs the remainder, so pool-mode
//! truncation dust is now distributed instead of stranded in escrow.

use soroban_sdk::{Address, BytesN, Env, String, Vec};

use crate::escrow;
use crate::events;
use crate::fees;
use crate::storage;
use crate::types::{Challenger, Claim, ClaimState, Error, PayoutQuote, Verdict, WinnerSide};
use crate::util;

pub fn resolve_claim(
    env: &Env,
    claim_id: u64,
    winner_side: WinnerSide,
    summary: String,
    confidence: u32,
    evidence_hash: BytesN<32>,
) -> Result<(), Error> {
    resolve_claim_versioned(
        env,
        claim_id,
        &Verdict::current(winner_side),
        summary,
        confidence,
        evidence_hash,
    )
}

/// Versioned entry point. The verdict's encoding version is validated before
/// any state is touched, so an unknown version fails closed with the claim left
/// exactly as it was and the escrow untouched.
pub fn resolve_claim_versioned(
    env: &Env,
    claim_id: u64,
    verdict: &Verdict,
    summary: String,
    confidence: u32,
    evidence_hash: BytesN<32>,
) -> Result<(), Error> {
    storage::oracle(env)?.require_auth();

    let mut claim = storage::get_claim(env, claim_id)?;
    if claim.state == ClaimState::Resolved {
        if claim.winner_side == winner_side
            && claim.resolution_summary == summary
            && claim.confidence == confidence
            && claim.evidence_hash == Some(evidence_hash.clone())
        {
            return Ok(());
        }
    }
    if claim.state != ClaimState::Active {
        return Err(Error::ClaimNotActive);
    }
    if env.ledger().timestamp() < claim.deadline {
        return Err(Error::NotYetExpired);
    }
    // Decode first: an unknown version must never be written, and `None` is not
    // a settled verdict. Both refusals leave the claim untouched.
    let winner_side = verdict.decode()?;
    if confidence > 100 {
        return Err(Error::InvalidConfidence);
    }

    claim.state = ClaimState::Resolved;
    claim.winner_side = winner_side;
    claim.resolution_summary = summary.clone();
    claim.confidence = confidence;
    claim.evidence_hash = Some(evidence_hash.clone());

    let inflow = claim
        .creator_stake
        .checked_add(claim.total_challenger_stake)
        .ok_or(Error::Overflow)?;
    let usdc = storage::usdc(env)?;
    let mut paid = 0i128;
    let mut taken_fees = 0i128;

    match winner_side {
        WinnerSide::Creator => {
            // The creator takes the whole pot. One transfer, so it stays inline.
            let (owed, taken) =
                fees::apply_fees(env, claim_id, claim.creator_stake, inflow, &claim.fees)?;
            escrow::push_or_park(env, &usdc, &claim.creator, owed);
            paid = paid.checked_add(owed).ok_or(Error::Overflow)?;
            taken_fees = taken_fees.checked_add(taken).ok_or(Error::Overflow)?;
            // Challengers are owed nothing.
            claim.remaining_escrow = 0;
        }

        WinnerSide::Challengers => {
            if util::is_fixed_odds(env, &claim.market.odds_mode) {
                // `reserved_creator_liability` is the exact sum of every
                // challenger's profit, accumulated with the same formula at
                // challenge time — so the unspent liability is known without
                // walking the roster.
                let refund = claim.creator_stake - claim.reserved_creator_liability;
                if refund > 0 {
                    // Unspent liability returning to a LOSING creator is a
                    // partial refund of principal, not profit, so it carries no
                    // fee.
                    escrow::push_or_park(env, &usdc, &claim.creator, refund);
                    paid = paid.checked_add(refund).ok_or(Error::Overflow)?;
                }
                claim.remaining_escrow = claim
                    .total_challenger_stake
                    .checked_add(claim.reserved_creator_liability)
                    .ok_or(Error::Overflow)?;
            } else {
                // Pool mode: challengers share the creator's stake on top of
                // their own.
                claim.remaining_escrow = inflow;
            }
        }

        // Draw or unresolvable: full refunds, no fee. Taking a cut of a returned
        // stake would make the protocol the only winner of an ambiguous market.
        _ => {
            escrow::push_or_park(env, &usdc, &claim.creator, claim.creator_stake);
            paid = paid.checked_add(claim.creator_stake).ok_or(Error::Overflow)?;
            claim.remaining_escrow = claim.total_challenger_stake;
        }
    }

    // Conservation, asserted on chain: what has been paid, taken as fees, and
    // still owed to challengers can never exceed what came in.
    let committed = paid
        .checked_add(taken_fees)
        .and_then(|value| value.checked_add(claim.remaining_escrow))
        .ok_or(Error::Overflow)?;
    if committed > inflow {
        return Err(Error::PayoutExceedsEscrow);
    }

    let dust = inflow.checked_sub(committed).ok_or(Error::PayoutExceedsEscrow)?;
    storage::set_claim(env, claim_id, &claim);
    // Persist the verdict with its explicit version tag. `claim.winner_side`
    // remains the compatibility mirror for callers that read the claim struct.
    storage::set_verdict(env, claim_id, verdict);
    storage::bump_total_resolved(env);

    events::MarketSettled {
        id: claim_id,
        total_paid: paid,
        total_fees: taken_fees,
        owed_to_challengers: claim.remaining_escrow,
        dust,
    }
    .publish(env);
    events::ClaimResolved {
        id: claim_id,
        winner_side,
        summary,
        confidence,
        evidence_hash,
    }
    .publish(env);
    events::VerdictEncoded {
        id: claim_id,
        version: verdict.version,
        winner_side,
    }
    .publish(env);
    Ok(())
}

/// The verdict for a resolved claim, decoded through its explicit version tag.
///
/// Read path:
///   * a stored versioned verdict is validated and returned, so an unknown
///     future version is refused instead of reinterpreted;
///   * a claim with no versioned record (resolved before verdicts were
///     versioned) falls back to `Claim.winner_side` and is reported as V1.
pub fn get_verdict(env: &Env, claim_id: u64) -> Result<Verdict, Error> {
    let claim = storage::get_claim(env, claim_id)?;
    if let Some(stored) = storage::verdict(env, claim_id) {
        // Validate on read as well as on write: a stored verdict whose version
        // this contract does not understand must not be decoded as V1.
        stored.decode()?;
        return Ok(stored);
    }
    if claim.state != ClaimState::Resolved {
        return Err(Error::ClaimNotResolved);
    }
    Verdict::from_unversioned(claim.winner_side)
}

// ── Per-challenger pull settlement ───────────────────────────────────────────

/// Locate a challenger on the roster, returning their index and entry.
fn find_challenger(
    roster: &Vec<Challenger>,
    who: &Address,
) -> Option<(u32, Challenger)> {
    for (index, entry) in roster.iter().enumerate() {
        if entry.address == *who {
            return Some((index as u32, entry));
        }
    }
    None
}

/// Gross owed to one challenger, before fees.
///
/// The last challenger to claim receives whatever is left in `remaining_escrow`
/// rather than the formula result, so truncation dust is fully distributed.
fn gross_for(
    env: &Env,
    claim: &Claim,
    stake: i128,
    is_last_claimant: bool,
) -> Result<i128, Error> {
    if is_last_claimant {
        return Ok(claim.remaining_escrow);
    }
    match claim.winner_side {
        WinnerSide::Challengers => {
            if util::is_fixed_odds(env, &claim.market.odds_mode) {
                fees::gross_payout(stake, claim.market.challenger_payout_bps)
            } else {
                let share = fees::pool_share(
                    stake,
                    claim.creator_stake,
                    claim.total_challenger_stake,
                )?;
                Ok(stake + share)
            }
        }
        // Draw or unresolvable: principal back, which apply_fees leaves untouched.
        _ => Ok(stake),
    }
}

/// Settle one challenger's position. Callable once per challenger once the claim
/// is resolved, and O(1) in the number of challengers.
pub fn claim_challenger_payout(
    env: &Env,
    challenger: Address,
    claim_id: u64,
) -> Result<i128, Error> {
    challenger.require_auth();

    let mut claim = storage::get_claim(env, claim_id)?;
    if claim.state != ClaimState::Resolved {
        return Err(Error::ClaimNotResolved);
    }
    // A creator win leaves challengers nothing to pull.
    if claim.winner_side == WinnerSide::Creator {
        return Err(Error::ChallengersDidNotWin);
    }

    let mut roster = storage::challengers(env, claim_id);
    let (index, mut entry) =
        find_challenger(&roster, &challenger).ok_or(Error::NotAChallenger)?;
    if entry.claimed {
        return Ok(0);
    }

    let claim_number = claim
        .challenger_claims
        .checked_add(1)
        .ok_or(Error::Overflow)?;
    let is_last_claimant = claim_number == claim.challenger_count;
    let gross = gross_for(env, &claim, entry.stake, is_last_claimant)?;

    // The escrow can never owe more than it holds for this claim.
    if gross > claim.remaining_escrow {
        return Err(Error::PayoutExceedsEscrow);
    }

    // Fees on profit only, so a winner never receives less than their principal.
    let (owed, _taken) = fees::apply_fees(env, claim_id, entry.stake, gross, &claim.fees)?;

    entry.claimed = true;
    roster.set(index, entry.clone());
    storage::set_challengers(env, claim_id, &roster);

    claim.remaining_escrow = claim
        .remaining_escrow
        .checked_sub(gross)
        .ok_or(Error::PayoutExceedsEscrow)?;
    claim.challenger_claims = claim_number;
    storage::set_claim(env, claim_id, &claim);

    let usdc = storage::usdc(env)?;
    escrow::push_or_park(env, &usdc, &challenger, owed);

    events::ChallengerPaid {
        id: claim_id,
        challenger,
        stake: entry.stake,
        gross,
        fee: gross - owed,
        net: owed,
    }
    .publish(env);
    Ok(owed)
}

/// What `claim_challenger_payout` would pay, without performing it.
pub fn quote_challenger_payout(
    env: &Env,
    claim_id: u64,
    challenger: &Address,
) -> Result<PayoutQuote, Error> {
    let empty = PayoutQuote {
        gross: 0,
        fee: 0,
        net: 0,
        claimed: false,
    };

    let claim = storage::get_claim(env, claim_id)?;
    let roster = storage::challengers(env, claim_id);
    let (_, entry) = match find_challenger(&roster, challenger) {
        Some(found) => found,
        None => return Ok(empty),
    };
    if claim.state != ClaimState::Resolved || claim.winner_side == WinnerSide::Creator {
        return Ok(PayoutQuote {
            claimed: entry.claimed,
            ..empty
        });
    }
    if entry.claimed {
        return Ok(PayoutQuote {
            claimed: true,
            ..empty
        });
    }

    let claim_number = claim
        .challenger_claims
        .checked_add(1)
        .ok_or(Error::Overflow)?;
    let is_last_claimant = claim_number == claim.challenger_count;
    let gross = gross_for(env, &claim, entry.stake, is_last_claimant)?;
    let (owed, fee) = fees::quote_fees(entry.stake, gross, &claim.fees)?;
    Ok(PayoutQuote {
        gross,
        fee,
        net: owed,
        claimed: false,
    })
}

// ── Pull endpoints ───────────────────────────────────────────────────────────

pub fn withdraw(env: &Env, who: Address) -> Result<i128, Error> {
    who.require_auth();
    let amount = storage::withdrawable(env, &who);
    if amount <= 0 {
        return Ok(0);
    }
    storage::clear_withdrawable(env, &who);
    let usdc = storage::usdc(env)?;
    escrow::push(env, &usdc, &who, amount);
    events::Withdrawal { to: who, amount }.publish(env);
    Ok(amount)
}

/// Claim accrued fees. Pull, not push: a fee recipient that fails on receipt must
/// not be able to block a settlement.
pub fn claim_fees(env: &Env, who: Address) -> Result<i128, Error> {
    who.require_auth();
    let amount = storage::accrued_fees(env, &who);
    if amount <= 0 {
        return Ok(0);
    }
    storage::clear_accrued_fees(env, &who); // effects before interaction
    storage::add_lifetime_fees_claimed(env, amount);
    let usdc = storage::usdc(env)?;
    escrow::push(env, &usdc, &who, amount);
    events::FeeClaimed {
        recipient: who,
        amount,
    }
    .publish(env);
    Ok(amount)
}
