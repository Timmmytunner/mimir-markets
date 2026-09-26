//! Typed contract events, mirroring the `event` declarations in MimirSquad.sol.

use soroban_sdk::{contractevent, Address, String};

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MarketCreated {
    #[topic]
    pub market_id: u64,
    #[topic]
    pub captain: Address,
    pub deadline: u64,
    pub fee_bps: u32,
    pub question: String,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Deposited {
    #[topic]
    pub market_id: u64,
    #[topic]
    pub side: u32,
    #[topic]
    pub participant: Address,
    pub amount: i128,
    pub shares: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Withdrawn {
    #[topic]
    pub market_id: u64,
    #[topic]
    pub side: u32,
    #[topic]
    pub participant: Address,
    pub amount: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Resolved {
    #[topic]
    pub market_id: u64,
    pub result: u32,
    pub pool_a: i128,
    pub pool_b: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Claimed {
    #[topic]
    pub market_id: u64,
    #[topic]
    pub participant: Address,
    pub gross: i128,
    pub fee: i128,
    pub net: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FeesClaimed {
    #[topic]
    pub recipient: Address,
    pub amount: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MarketFeesClaimed {
    #[topic]
    pub market_id: u64,
    #[topic]
    pub recipient: Address,
    pub amount: i128,
}
