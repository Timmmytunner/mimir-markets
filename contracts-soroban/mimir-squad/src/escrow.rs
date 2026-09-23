//! USDC custody for the squad pool.

use soroban_sdk::{token, Address, Env};

use crate::types::{Error, USDC_DECIMALS};

/// Refuse an escrow token whose scale is not [`USDC_DECIMALS`]. A token that
/// cannot answer `decimals()` is not a SEP-41 token, so it is rejected as
/// unsupported rather than trapping.
pub fn require_usdc_decimals(env: &Env, usdc: &Address) -> Result<(), Error> {
    match token::TokenClient::new(env, usdc).try_decimals() {
        Ok(Ok(decimals)) if decimals == USDC_DECIMALS => Ok(()),
        Ok(Ok(_)) => Err(Error::UnsupportedDecimals),
        _ => Err(Error::UnsupportedToken),
    }
}

/// Move `amount` from `from` into contract escrow, asserting the escrow balance
/// moved by exactly that much. Fee-on-transfer and rebasing assets would break
/// pool accounting, so they are rejected at the door.
pub fn pull(env: &Env, usdc: &Address, from: &Address, amount: i128) -> Result<(), Error> {
    let client = token::TokenClient::new(env, usdc);
    let here = env.current_contract_address();
    let before = client.balance(&here);
    client.transfer(from, &here, &amount);
    if client.balance(&here) != before + amount {
        return Err(Error::UnsupportedToken);
    }
    Ok(())
}

/// Push a payout. Squad settlement is already pull-based per participant, so a
/// failure here affects only the caller and is allowed to propagate — matching
/// `require(usdc.transfer(...))` in the Solidity.
pub fn push(env: &Env, usdc: &Address, to: &Address, amount: i128) {
    token::TokenClient::new(env, usdc).transfer(&env.current_contract_address(), to, &amount);
}

pub fn balance(env: &Env, usdc: &Address) -> i128 {
    token::TokenClient::new(env, usdc).balance(&env.current_contract_address())
}
