//! Claim lifecycle: create, challenge, cancel.

use soroban_sdk::{Address, Env, String, Vec};

use crate::escrow;
use crate::events;
use crate::fees;
use crate::storage;
use crate::types::{
    Challenger, Claim, ClaimState, CreateParams, Error, FeeSnapshot, MarketConfig, WinnerSide,
    BPS_DIVISOR, CHALLENGE_LOCK_SECONDS, DEFAULT_PAYOUT_BPS, MAX_CHALLENGERS, MIN_STAKE,
};
use crate::util;

pub fn create_claim(env: &Env, creator: Address, params: CreateParams) -> Result<u64, Error> {
    creator.require_auth();

    if params.stake_amount < MIN_STAKE {
        return Err(Error::StakeTooSmall);
    }
    if params.deadline <= env.ledger().timestamp() {
        return Err(Error::DeadlineInPast);
    }
    if params.question.is_empty() {
        return Err(Error::EmptyQuestion);
    }

    let usdc = storage::usdc(env)?;
    escrow::pull(env, &usdc, &creator, params.stake_amount)?;

    let is_fixed = util::is_fixed_odds(env, &params.odds_mode);
    let payout_bps = if is_fixed {
        if params.challenger_payout_bps as i128 >= BPS_DIVISOR {
            params.challenger_payout_bps
        } else {
            DEFAULT_PAYOUT_BPS
        }
    } else {
        0
    };

    let max_challengers = if params.max_challengers == 0 || params.max_challengers > MAX_CHALLENGERS
    {
        MAX_CHALLENGERS
    } else {
        params.max_challengers
    };

    let invite_key_hash = match &params.invite_key {
        Some(key) if !key.is_empty() => Some(util::hash_string(env, key)?),
        _ => None,
    };

    let id = storage::claim_count(env) + 1;
    storage::set_claim_count(env, id);

    // The policy in force NOW is frozen onto the claim. A later change cannot
    // reach a market whose participants have already committed money.
    let current = storage::fee_policy(env)?;
    let snapshot = FeeSnapshot {
        platform_fee_bps: current.platform_fee_bps,
        agent_owner_fee_bps: current.agent_owner_fee_bps,
        platform_recipient: current.platform_recipient,
        agent_owner_recipient: params.agent_owner_recipient.clone(),
    };

    let claim = Claim {
        creator: creator.clone(),
        question: params.question,
        creator_position: params.creator_position,
        counter_position: params.counter_position,
        resolution_url: params.resolution_url,
        creator_stake: params.stake_amount,
        total_challenger_stake: 0,
        reserved_creator_liability: 0,
        deadline: params.deadline,
        state: ClaimState::Open,
        winner_side: WinnerSide::None,
        resolution_summary: String::from_str(env, ""),
        confidence: 0,
        category: util::or_default(env, &params.category, "custom"),
        parent_id: params.parent_id,
        challenger_count: 0,
        remaining_escrow: 0,
        challenger_claims: 0,
        created_at: env.ledger().timestamp(),
        evidence_hash: None,
        context_hash: params.context_hash,
        market: MarketConfig {
            market_type: util::or_default(env, &params.market_type, "binary"),
            odds_mode: String::from_str(env, if is_fixed { "fixed" } else { "pool" }),
            challenger_payout_bps: payout_bps,
            handicap_line: params.handicap_line,
            settlement_rule: params.settlement_rule,
            max_challengers,
            is_private: params.is_private,
            invite_key_hash,
        },
        fees: snapshot.clone(),
    };

    let category = claim.category.clone();
    storage::set_claim(env, id, &claim);
    storage::set_challengers(env, id, &Vec::new(env));

    events::ClaimCreated {
        id,
        creator,
        category,
    }
    .publish(env);
    events::FeePolicySnapshotted {
        id,
        platform_fee_bps: snapshot.platform_fee_bps,
        agent_owner_fee_bps: snapshot.agent_owner_fee_bps,
        platform_recipient: snapshot.platform_recipient.clone(),
        agent_owner_recipient: snapshot.agent_owner_recipient.clone(),
    }
    .publish(env);
    if let Some(agent) = params.agent_owner_recipient {
        events::AgentAttributed {
            id,
            agent_owner_recipient: agent,
        }
        .publish(env);
    }
    Ok(id)
}

pub fn challenge_claim(
    env: &Env,
    challenger: Address,
    claim_id: u64,
    stake_amount: i128,
    invite_key: Option<String>,
) -> Result<(), Error> {
    challenger.require_auth();

    let mut claim = storage::get_claim(env, claim_id)?;
    if claim.state != ClaimState::Open && claim.state != ClaimState::Active {
        return Err(Error::ClaimNotOpen);
    }
    if challenger == claim.creator {
        return Err(Error::SelfChallenge);
    }

    let mut list = storage::challengers(env, claim_id);
    for existing in list.iter() {
        if existing.address == challenger {
            return Err(Error::AlreadyChallenged);
        }
    }
    if claim.challenger_count >= claim.market.max_challengers {
        return Err(Error::ClaimFull);
    }
    if stake_amount < MIN_STAKE {
        return Err(Error::StakeTooSmall);
    }
    // Anti-sniping: a challenge must land at least CHALLENGE_LOCK_SECONDS before
    // the deadline.
    let earliest_close = env
        .ledger()
        .timestamp()
        .checked_add(CHALLENGE_LOCK_SECONDS)
        .ok_or(Error::Overflow)?;
    if earliest_close > claim.deadline {
        return Err(Error::ChallengeWindowClosed);
    }

    if claim.market.is_private {
        if let Some(expected) = claim.market.invite_key_hash.clone() {
            let supplied = match &invite_key {
                Some(key) => util::hash_string(env, key)?,
                None => return Err(Error::InvalidInviteKey),
            };
            if supplied != expected {
                return Err(Error::InvalidInviteKey);
            }
        }
    }

    // A one-slot market is a duel, so the stakes must match. v1 could not enforce
    // this on chain and relied on an off-chain guard; v2 can.
    if claim.market.max_challengers == 1 && stake_amount != claim.creator_stake {
        return Err(Error::DuelNeedsEqualStake);
    }

    let mut fixed_odds_gross = 0;
    let mut fixed_odds_profit = 0;
    if util::is_fixed_odds(env, &claim.market.odds_mode) {
        fixed_odds_gross = fees::gross_payout(stake_amount, claim.market.challenger_payout_bps)?;
        fixed_odds_profit = if fixed_odds_gross > stake_amount {
            fixed_odds_gross - stake_amount
        } else {
            0
        };
        // Treat a corrupt/legacy claim with more liability than principal as
        // underfunded rather than allowing a negative "available" balance or a
        // wrapping subtraction in the release build.
        let available = claim
            .creator_stake
            .checked_sub(claim.reserved_creator_liability)
            .ok_or(Error::InsufficientCreatorLiquidity)?;
        if available < fixed_odds_profit {
            return Err(Error::InsufficientCreatorLiquidity);
        }
        claim.reserved_creator_liability = claim
            .reserved_creator_liability
            .checked_add(fixed_odds_profit)
            .ok_or(Error::Overflow)?;
    }

    let next_total_challenger_stake = claim
        .total_challenger_stake
        .checked_add(stake_amount)
        .ok_or(Error::Overflow)?;
    let next_challenger_count = claim
        .challenger_count
        .checked_add(1)
        .ok_or(Error::Overflow)?;

    let usdc = storage::usdc(env)?;
    escrow::pull(env, &usdc, &challenger, stake_amount)?;

    list.push_back(Challenger {
        address: challenger.clone(),
        stake: stake_amount,
        claimed: false,
    });
    storage::set_challengers(env, claim_id, &list);

    claim.total_challenger_stake = next_total_challenger_stake;
    claim.challenger_count = next_challenger_count;
    claim.state = ClaimState::Active;
    storage::set_claim(env, claim_id, &claim);

    if util::is_fixed_odds(env, &claim.market.odds_mode) {
        events::FixedOddsLiquidityReserved {
            id: claim_id,
            challenger: challenger.clone(),
            stake: stake_amount,
            gross: fixed_odds_gross,
            profit: fixed_odds_profit,
            reserved_creator_liability: claim.reserved_creator_liability,
            available_creator_liquidity: claim
                .creator_stake
                .checked_sub(claim.reserved_creator_liability)
                .ok_or(Error::InsufficientCreatorLiquidity)?,
        }
        .publish(env);
    }

    events::ClaimChallenged {
        id: claim_id,
        challenger,
        stake: stake_amount,
    }
    .publish(env);
    Ok(())
}


pub fn transition_deadline(env: &Env, claim_id: u64) -> Result<(), Error> {
    let mut claim = storage::get_claim(env, claim_id)?;
    if claim.state == ClaimState::Active {
        return Ok(());
    }
    if claim.state != ClaimState::Open {
        return Err(Error::ClaimNotOpen);
    }
    if env.ledger().timestamp() < claim.deadline {
        return Err(Error::Timelocked);
    }

    claim.state = ClaimState::Cancelled;
    let creator = claim.creator.clone();
    let refund = claim.creator_stake;
    storage::set_claim(env, claim_id, &claim);

    // Cancellation is a refund: no fee. Same parked-flag semantics as
    // `cancel_claim` below: report the DELTA, because the creator may already
    // hold a parked balance from an earlier settlement that is not this refund.
    let usdc = storage::usdc(env)?;
    let pending_before = storage::withdrawable(env, &creator);
    escrow::push_or_park(env, &usdc, &creator, refund);

    events::ClaimCancelled {
        id: claim_id,
        refund,
        parked: storage::withdrawable(env, &creator) > pending_before,
    }
    .publish(env);
    Ok(())
}

pub fn cancel_claim(env: &Env, claim_id: u64) -> Result<(), Error> {
    let mut claim = storage::get_claim(env, claim_id)?;
    claim.creator.require_auth();
    if claim.state == ClaimState::Cancelled {
        return Ok(());
    }
    if claim.state != ClaimState::Open {
        return Err(Error::ClaimNotOpen);
    }

    // Cancellation is the one lifecycle transition where the creator, not the
    // oracle, moves money out of escrow. The state check above is what every
    // caller knows; the checks below are what the CONTRACT knows. They guard
    // against the two ways a refund could diverge from the escrow the claim
    // actually holds, whatever a stale or corrupt read-index claims:
    //
    //  1. Counterparty exposure. An Open claim holds ONLY the creator's stake:
    //     `challenger_count == 0`, `total_challenger_stake == 0`, and — because
    //     a fixed-odds challenge reserves part of the creator stake —
    //     `reserved_creator_liability == 0`. Any nonzero value means at least
    //     one challenger has funded this market (or its state transition was
    //     never completed), so a refund here would strand their funds behind a
    //     `Cancelled` terminal state that settlement can never reach. This is
    //     the defense-in-depth guard the state machine relies on: `Open` is
    //     checked against the claim's OWN funded positions, not just its
    //     lifecycle label, and it covers a target claim on a stale read-index,
    //     a mid-flight challenge on a fork of the ledger, and any worker that
    //     stops challenging after a cancelled/active read. Indexers must treat
    //     `Open` with counterparty exposure as corrupt, never as cancellable.
    //  2. Escrow solvency. The refund is paid from contract escrow, which also
    //     holds every other claim's funds and accrued fees. If it cannot cover
    //     this refund RIGHT NOW, minting a `Cancelled` state and a parked
    //     withdrawable balance would pay the creator out of OTHER claims'
    //     funds. Instead the call reverts with nothing written: the claim stays
    //     Open, the creator keeps their position, and they can retry once the
    //     contract is solvent again.
    if claim.challenger_count != 0
        || claim.total_challenger_stake != 0
        || claim.reserved_creator_liability != 0
    {
        events::CancellationRefused {
            id: claim_id,
            challenger_count: claim.challenger_count,
            total_challenger_stake: claim.total_challenger_stake,
            reserved_creator_liability: claim.reserved_creator_liability,
            reason: Error::ClaimHasActiveClaims as u32,
        }
        .publish(env);
        return Err(Error::ClaimHasActiveClaims);
    }

    let refund = claim.creator_stake;
    let usdc = storage::usdc(env)?;
    if escrow::balance(env, &usdc) < refund {
        events::CancellationRefused {
            id: claim_id,
            challenger_count: claim.challenger_count,
            total_challenger_stake: claim.total_challenger_stake,
            reserved_creator_liability: claim.reserved_creator_liability,
            reason: Error::RefundNotEscrowed as u32,
        }
        .publish(env);
        return Err(Error::RefundNotEscrowed);
    }

    claim.state = ClaimState::Cancelled;
    let creator = claim.creator.clone();
    storage::set_claim(env, claim_id, &claim);

    // Cancellation is a refund: no fee. A refund is not profit, so no fee leg
    // can exist, and a failed push parks the refund as a withdrawable balance
    // rather than failing a cancellation whose accounting is already final.
    // The event reports the DELTA: the creator may already hold a parked
    // balance from an earlier settlement, and that is not this refund.
    let pending_before = storage::withdrawable(env, &creator);
    escrow::push_or_park(env, &usdc, &creator, refund);

    events::ClaimCancelled {
        id: claim_id,
        refund,
        parked: storage::withdrawable(env, &creator) > pending_before,
    }
    .publish(env);
    Ok(())
}
