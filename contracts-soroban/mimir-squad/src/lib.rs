#![no_std]
//! Mimir squad — two-sided USDC pool on Soroban.
//!
//! Port of `contracts/MimirSquad.sol`. Shares equal deposited atomic units and
//! captains have no economic privilege. Settlement is pull-based per participant,
//! fees are charged on profit only, and the last winner to claim absorbs the
//! remaining escrow so truncation dust is never stranded.
//!
//! Deliberate deviations from the Solidity original are marked
//! `DEVIATION FROM SOLIDITY` at the point they occur.

mod escrow;
pub mod events;
mod pool;
mod storage;
mod types;

pub mod contract;

pub use contract::{MimirSquad, MimirSquadClient};
pub use types::*;

#[cfg(test)]
mod test_common;
#[cfg(test)]
mod test_decimals;
#[cfg(test)]
mod test_fee_rounding;
#[cfg(test)]
mod test_lifecycle;
#[cfg(test)]
mod test_payouts;
