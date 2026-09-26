//! Value types for the squad pool. Mirrors `contracts/MimirSquad.sol`.

use soroban_sdk::{contracterror, contracttype, Address};

// ── Constants (mirror MimirSquad.sol) ────────────────────────────────────────

pub const SIDE_A: u32 = 1;
pub const SIDE_B: u32 = 2;
pub const RESULT_CANCELLED: u32 = 3;

pub const MAX_FEE_BPS: u32 = 1_000;
pub const MAX_PARTICIPANTS_PER_SIDE: u32 = 200;
pub const MIN_DURATION: u64 = 600; // 10 minutes
pub const MAX_DURATION: u64 = 31_536_000; // 365 days

pub const BPS_DIVISOR: i128 = 10_000;

/// Decimals of the escrow token. A Stellar Asset Contract exposes every classic
/// asset, Circle's USDC included, with exactly 7. Shares equal deposited atomic
/// units, so this is also the scale every share is read at off-chain;
/// `initialize` refuses a token that reports any other.
pub const USDC_DECIMALS: u32 = 7;

// ── Storage shapes ───────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Market {
    pub captain: Address,
    pub deadline: u64,
    pub fee_bps: u32,
    /// `0` until resolved, then SIDE_A / SIDE_B / RESULT_CANCELLED.
    pub result: u32,
    pub resolved: bool,
    pub pool_a: i128,
    pub pool_b: i128,
    pub remaining_escrow: i128,
    pub participants_a: u32,
    pub participants_b: u32,
    pub winner_claims: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClaimResult {
    pub gross: i128,
    pub fee: i128,
    pub net: i128,
}

/// Per-market accrued fee ledger. `seq` ties the balance to the current
/// `fee_claim_seq` so a global `claim_fees` can invalidate every market
/// ledger without iterating storage (Soroban footprint bound).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MarketFeeBalance {
    pub amount: i128,
    pub seq: u64,
}

// ── Errors ───────────────────────────────────────────────────────────────────

#[contracterror]
#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd)]
#[repr(u32)]
pub enum Error {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    ZeroAddress = 3,
    EmptyQuestion = 4,
    BadDeadline = 5,
    FeeCapExceeded = 6,
    MarketNotFound = 7,
    MarketClosed = 8,
    BadSide = 9,
    ZeroAmount = 10,
    SideFull = 11,
    Locked = 12,
    BadAmount = 13,
    NotOracle = 14,
    NotResolvable = 15,
    BadResult = 16,
    EmptyWinner = 17,
    NotClaimable = 18,
    NotWinner = 19,
    AlreadyClaimed = 20,
    NotFeeRecipient = 21,
    NoFees = 22,
    UnsupportedToken = 23,
    Overflow = 24,
    UnsupportedDecimals = 25,
    ConservationViolation = 26,
}
