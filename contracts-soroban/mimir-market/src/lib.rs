#![no_std]
//! Mimir market — oracle-settled prediction market on Soroban.
//!
//! Port of `contracts/MimirV2.sol`. Stakes are held in a USDC Stellar Asset
//! Contract; fees are charged on PROFIT only, snapshotted per claim, and any
//! policy change is timelocked under a hard constant cap.
//!
//! Deliberate deviations from the Solidity original are marked
//! `DEVIATION FROM SOLIDITY` at the point they occur.

mod admin;
mod claims;
mod escrow;
mod fees;
pub mod events;
mod resolve;
mod storage;
mod types;
mod util;

pub mod contract;

pub use contract::{MimirMarket, MimirMarketClient};
pub use types::*;

#[cfg(test)]
mod test_common;
#[cfg(test)]
mod test_decimals;
#[cfg(test)]
mod test_fees;
#[cfg(test)]
mod test_lifecycle;
#[cfg(test)]
mod test_settlement;
