//! Value types for the Mimir market. Mirrors the structs and enums of
//! `contracts/MimirV2.sol`.

use soroban_sdk::{contracterror, contracttype, Address, BytesN, String};

// ── Limits (mirror MimirV2.sol) ──────────────────────────────────────────────

pub const MAX_CHALLENGERS: u32 = 100;

/// Decimals of the escrow token. A Stellar Asset Contract exposes every classic
/// asset, Circle's USDC included, with exactly 7.
///
/// Enforced, not assumed: `initialize` reads `decimals()` off the token and
/// refuses any other scale, so no amount constant below can be read at a scale
/// it was not written for.
pub const USDC_DECIMALS: u32 = 7;

/// One whole USDC in atomic units.
pub const USDC_UNIT: i128 = 10i128.pow(USDC_DECIMALS);

/// Minimum stake, in atomic USDC units.
///
/// DEVIATION FROM SOLIDITY: the EVM original used `2 * 10**6` because USDC on
/// Base is a 6-decimal ERC-20. The same 2 USDC at [`USDC_DECIMALS`] is
/// `2 * 10**7` here. Against a 6-decimal token this constant would silently mean
/// 20 USDC, which is why `initialize` rejects one.
pub const MIN_STAKE: i128 = 2 * USDC_UNIT;

pub const DEFAULT_PAYOUT_BPS: u32 = 20_000; // 2x total return
pub const CHALLENGE_LOCK_SECONDS: u64 = 60;
pub const BPS_DIVISOR: i128 = 10_000;

/// Hard ceiling on `platform_fee_bps + agent_owner_fee_bps`, checked on every
/// policy change. Immutable by construction: no function can raise it, so no
/// admin action and no compromised key can take more than 10% of profit.
pub const MAX_TOTAL_FEE_BPS: u32 = 1_000;

/// A queued policy change cannot take effect before this much time passes.
pub const FEE_TIMELOCK_SECONDS: u64 = 172_800; // 2 days

/// Upper bound on the byte length of an invite key.
///
/// DEVIATION FROM SOLIDITY: `keccak256(bytes(inviteKey))` accepted any length.
/// Hashing a Soroban `String` requires marshalling it through a fixed-size host
/// buffer, so a bound is required. 128 bytes is far above any realistic key.
pub const MAX_INVITE_KEY_BYTES: u32 = 128;

// ── Enums ────────────────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ClaimState {
    Open = 0,
    Active = 1,
    Resolved = 2,
    Cancelled = 3,
}

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WinnerSide {
    None = 0,
    Creator = 1,
    Challengers = 2,
    Draw = 3,
    Unresolvable = 4,
}

// ── Fee policy ───────────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FeePolicy {
    pub platform_fee_bps: u32,
    pub agent_owner_fee_bps: u32,
    pub platform_recipient: Option<Address>,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingFeePolicy {
    pub platform_fee_bps: u32,
    pub agent_owner_fee_bps: u32,
    pub platform_recipient: Option<Address>,
    pub executable_at: u64,
}

/// Copied onto each claim at creation and never mutated afterwards.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FeeSnapshot {
    pub platform_fee_bps: u32,
    pub agent_owner_fee_bps: u32,
    pub platform_recipient: Option<Address>,
    pub agent_owner_recipient: Option<Address>,
}

// ── Claim ────────────────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MarketConfig {
    pub market_type: String,
    pub odds_mode: String,
    pub challenger_payout_bps: u32,
    pub handicap_line: String,
    pub settlement_rule: String,
    pub max_challengers: u32,
    pub is_private: bool,
    pub invite_key_hash: Option<BytesN<32>>,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Challenger {
    pub address: Address,
    pub stake: i128,
    /// Set once this challenger has pulled their settlement. Held on the roster
    /// entry rather than in a side map so `get_challenger_list` can report claim
    /// status without an extra read per challenger.
    pub claimed: bool,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Claim {
    pub creator: Address,
    pub question: String,
    pub creator_position: String,
    pub counter_position: String,
    pub resolution_url: String,
    pub creator_stake: i128,
    pub total_challenger_stake: i128,
    pub reserved_creator_liability: i128,
    pub deadline: u64,
    pub state: ClaimState,
    pub winner_side: WinnerSide,
    pub resolution_summary: String,
    pub confidence: u32,
    pub category: String,
    pub parent_id: u64,
    pub challenger_count: u32,
    /// Escrow still owed to challengers after resolution. Seeded by
    /// `resolve_claim` and drawn down by each `claim_challenger_payout`, so the
    /// contract can never pay out more than it took in.
    pub remaining_escrow: i128,
    /// How many challengers have pulled their settlement. The last one absorbs
    /// whatever `remaining_escrow` is left, so truncation dust is never stranded.
    pub challenger_claims: u32,
    pub created_at: u64,
    pub evidence_hash: Option<BytesN<32>>,
    pub context_hash: BytesN<32>,
    pub market: MarketConfig,
    pub fees: FeeSnapshot,
}

// ── Create parameters ────────────────────────────────────────────────────────

/// Mirrors `MimirV2.CreateParams`. Grouped into a struct for the same reason the
/// Solidity did: the argument list is otherwise unwieldy.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CreateParams {
    pub question: String,
    pub creator_position: String,
    pub counter_position: String,
    pub resolution_url: String,
    pub deadline: u64,
    pub stake_amount: i128,
    pub category: String,
    pub parent_id: u64,
    pub market_type: String,
    pub odds_mode: String,
    pub challenger_payout_bps: u32,
    pub handicap_line: String,
    pub settlement_rule: String,
    pub max_challengers: u32,
    pub is_private: bool,
    pub invite_key: Option<String>,
    pub context_hash: BytesN<32>,
    /// `None` when the market is not attributed to an agent.
    pub agent_owner_recipient: Option<Address>,
}

// ── View return shapes ───────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClaimFeeView {
    pub platform_fee_bps: u32,
    pub agent_owner_fee_bps: u32,
    pub platform_recipient: Option<Address>,
    pub agent_owner_recipient: Option<Address>,
    pub context_hash: BytesN<32>,
}

/// What a challenger would receive from `claim_challenger_payout`, without
/// performing it.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PayoutQuote {
    pub gross: i128,
    pub fee: i128,
    pub net: i128,
    pub claimed: bool,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlatformStats {
    pub total_claims: u64,
    pub resolved: u64,
    pub balance: i128,
    pub fees_accrued: i128,
    pub fees_claimed: i128,
}

// ── Errors ───────────────────────────────────────────────────────────────────

#[contracterror]
#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd)]
#[repr(u32)]
pub enum Error {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    NotOwner = 3,
    NotOracle = 4,
    FeeCapExceeded = 5,
    FeeNeedsRecipient = 6,
    NothingQueued = 7,
    Timelocked = 8,
    StakeTooSmall = 9,
    DeadlineInPast = 10,
    EmptyQuestion = 11,
    ClaimNotFound = 12,
    ClaimNotOpen = 13,
    SelfChallenge = 14,
    AlreadyChallenged = 15,
    ClaimFull = 16,
    ChallengeWindowClosed = 17,
    InvalidInviteKey = 18,
    DuelNeedsEqualStake = 19,
    InsufficientCreatorLiquidity = 20,
    ClaimNotActive = 21,
    NotYetExpired = 22,
    InvalidVerdict = 23,
    NotCreator = 24,
    NothingToWithdraw = 25,
    NoFees = 26,
    PayoutExceedsEscrow = 27,
    UnsupportedToken = 28,
    Overflow = 29,
    InviteKeyTooLong = 30,
    ZeroStake = 31,
    ClaimNotResolved = 32,
    NotAChallenger = 33,
    AlreadyClaimedPayout = 34,
    ChallengersDidNotWin = 35,
    UnsupportedDecimals = 36,
}
