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

// ── Versioned verdict encoding ────────────────────────────────────────────────

/// Current version of the on-chain verdict encoding.
///
/// The tag is stored alongside every verdict written by `resolve_claim` so an
/// indexer, worker, or future contract version can tell WHICH encoding produced
/// a stored decision instead of guessing from the shape of the value. Bump this
/// only together with an explicit decode path for the older versions.
pub const VERDICT_VERSION_V1: u32 = 1;

/// An oracle verdict carrying its own encoding version.
///
/// `version` is an explicit discriminant, not an inference: a reader that does
/// not know a version must refuse the verdict rather than reinterpret its
/// fields. `side` is the decision as encoded under that version. `None` is
/// never a settled verdict, so it is rejected by [`Verdict::decode`] at both
/// write and read time.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Verdict {
    pub version: u32,
    pub side: WinnerSide,
}

impl Verdict {
    /// Encode a verdict at the current version. Used by the legacy
    /// `resolve_claim` entry point, whose callers pass a bare `WinnerSide`.
    pub fn current(side: WinnerSide) -> Self {
        Verdict {
            version: VERDICT_VERSION_V1,
            side,
        }
    }

    /// Validate the version tag and return the decoded side.
    ///
    /// Unknown versions are refused with [`Error::UnsupportedVerdictVersion`]
    /// so a verdict written by a newer encoding can never be silently read as
    /// version 1. `None` is refused with [`Error::InvalidVerdict`].
    pub fn decode(&self) -> Result<WinnerSide, Error> {
        if self.version != VERDICT_VERSION_V1 {
            return Err(Error::UnsupportedVerdictVersion);
        }
        match self.side {
            WinnerSide::None => Err(Error::InvalidVerdict),
            side => Ok(side),
        }
    }

    /// Backward-compatible decode path for claims resolved before the version
    /// tag existed. Those claims store only `Claim::winner_side`, which is by
    /// construction a version-1 encoding, so it is promoted to an explicit
    /// [`Verdict`] instead of being read as a bare enum forever.
    pub fn from_unversioned(side: WinnerSide) -> Result<Self, Error> {
        match side {
            WinnerSide::None => Err(Error::ClaimNotResolved),
            side => Ok(Verdict {
                version: VERDICT_VERSION_V1,
                side,
            }),
        }
    }
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

/// A paginated window into a claim's challenger roster.
///
/// `items` holds up to `limit` entries starting at `offset`.  
/// `total` is the total roster length so callers can tell when they have read
/// the last page without fetching an extra empty one.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ChallengerPage {
    /// The slice of challengers for this page.
    pub items: soroban_sdk::Vec<Challenger>,
    /// Roster position of the first item returned (mirrors the caller's
    /// `offset` argument for safe cursor book-keeping).
    pub offset: u32,
    /// Total number of challengers in this claim (not just this page).
    pub total: u32,
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
    InvalidConfidence = 37,
    /// `cancel_claim` refused because the claim still holds counterparty funds
    /// or a reserved creator liability: challengers have funded this market, so
    /// it belongs to settlement, not to a creator refund.
    ClaimHasActiveClaims = 38,
    /// Escrow could not back the cancellation refund at the moment of the call.
    /// The refund is never minted; the claim stays untouched and the creator
    /// can retry once the contract is solvent again.
    RefundNotEscrowed = 39,
    /// A verdict carried an encoding version this contract cannot decode. The
    /// verdict is refused rather than reinterpreted, so resolution fails closed
    /// and the claim is left untouched.
    UnsupportedVerdictVersion = 40,
}
