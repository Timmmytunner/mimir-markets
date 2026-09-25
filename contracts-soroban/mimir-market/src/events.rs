//! Typed contract events, mirroring the `event` declarations in MimirV2.sol.

use soroban_sdk::{contractevent, Address, BytesN, String};

use crate::types::WinnerSide;

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClaimCreated {
    #[topic]
    pub id: u64,
    #[topic]
    pub creator: Address,
    pub category: String,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClaimChallenged {
    #[topic]
    pub id: u64,
    #[topic]
    pub challenger: Address,
    pub stake: i128,
}

/// A fixed-odds challenge consumed part of the creator's liquidity guarantee.
/// `reserved_creator_liability` and `available_creator_liquidity` are snapshots
/// after this challenge, so an indexer can audit the limit without replaying
/// the roster or trusting a stale read-index calculation.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FixedOddsLiquidityReserved {
    #[topic]
    pub id: u64,
    #[topic]
    pub challenger: Address,
    pub stake: i128,
    pub gross: i128,
    pub profit: i128,
    pub reserved_creator_liability: i128,
    pub available_creator_liquidity: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClaimResolved {
    #[topic]
    pub id: u64,
    pub winner_side: WinnerSide,
    pub summary: String,
    pub confidence: u32,
    pub evidence_hash: BytesN<32>,
}

/// The versioned verdict written at resolution, emitted alongside
/// `ClaimResolved`.
///
/// `ClaimResolved` keeps its existing shape for compatible indexers; this event
/// carries the explicit encoding version so consumers can pin the verdict
/// encoding without a second read or a schema guess.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VerdictEncoded {
    #[topic]
    pub id: u64,
    pub version: u32,
    pub winner_side: WinnerSide,
}

/// The creator's refund of an unchallenged claim. `refund` lets an indexer
/// reconcile the refund against `creator_stake` and escrow without a second
/// read; `parked` distinguishes a delivered refund from one parked as a
/// withdrawable balance when the creator's trustline refused the transfer.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClaimCancelled {
    #[topic]
    pub id: u64,
    pub refund: i128,
    pub parked: bool,
}

/// Defensive halt: the claim's accounting shows counterparty funds or a
/// reserved creator liability while its lifecycle state claims to be `Open`.
/// The cancellation was refused and NOTHING changed — this event is the
/// on-chain record for keepers, indexers and incident response.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CancellationRefused {
    #[topic]
    pub id: u64,
    pub challenger_count: u32,
    pub total_challenger_stake: i128,
    pub reserved_creator_liability: i128,
    pub reason: u32,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OracleChanged {
    #[topic]
    pub next: Address,
    pub previous: Option<Address>,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OwnershipTransferred {
    #[topic]
    pub next: Address,
    pub previous: Option<Address>,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WithdrawalPending {
    #[topic]
    pub to: Address,
    pub amount: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Withdrawal {
    #[topic]
    pub to: Address,
    pub amount: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FeePolicyQueued {
    pub platform_fee_bps: u32,
    pub agent_owner_fee_bps: u32,
    pub platform_recipient: Option<Address>,
    pub executable_at: u64,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FeePolicyUpdated {
    pub platform_fee_bps: u32,
    pub agent_owner_fee_bps: u32,
    pub platform_recipient: Option<Address>,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FeePolicyCancelled {
    pub cancelled: bool,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentAttributed {
    #[topic]
    pub id: u64,
    #[topic]
    pub agent_owner_recipient: Address,
}

/// Frozen fee terms written onto a claim at creation. Indexers can treat this as
/// the authoritative economics for the market; a later `FeePolicyUpdated` must
/// not rewrite them.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FeePolicySnapshotted {
    #[topic]
    pub id: u64,
    pub platform_fee_bps: u32,
    pub agent_owner_fee_bps: u32,
    pub platform_recipient: Option<Address>,
    pub agent_owner_recipient: Option<Address>,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FeeAccrued {
    #[topic]
    pub id: u64,
    #[topic]
    pub recipient: Address,
    pub amount: i128,
    pub is_agent_owner_fee: bool,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FeeClaimed {
    #[topic]
    pub recipient: Address,
    pub amount: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MarketSettled {
    #[topic]
    pub id: u64,
    pub total_paid: i128,
    pub total_fees: i128,
    /// Escrow left for challengers to pull via `claim_challenger_payout`.
    pub owed_to_challengers: i128,
    pub dust: i128,
}

/// One challenger's settlement. Together with `ClaimChallenged` and
/// `ClaimResolved` this gives an off-chain indexer everything it needs to derive
/// per-address win/loss records, which are no longer tracked on chain.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ChallengerPaid {
    #[topic]
    pub id: u64,
    #[topic]
    pub challenger: Address,
    pub stake: i128,
    pub gross: i128,
    pub fee: i128,
    pub net: i128,
}
