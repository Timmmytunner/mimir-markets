//! USDC custody: exact-amount pulls, and pushes that fall back to a pull.

use soroban_sdk::{token, Address, Env};

use crate::events;
use crate::storage;
use crate::types::{Error, USDC_DECIMALS};

/// Refuse an escrow token whose scale is not [`USDC_DECIMALS`].
///
/// Every amount constant and every off-chain parser is written at that scale.
/// Against a 6-decimal token `MIN_STAKE` would silently mean 20 USDC; against an
/// 18-decimal one it would be dust. A token that cannot answer `decimals()` is
/// not a SEP-41 token, so it is rejected as unsupported rather than trapping.
pub fn require_usdc_decimals(env: &Env, usdc: &Address) -> Result<(), Error> {
    match token::TokenClient::new(env, usdc).try_decimals() {
        Ok(Ok(decimals)) if decimals == USDC_DECIMALS => Ok(()),
        Ok(Ok(_)) => Err(Error::UnsupportedDecimals),
        _ => Err(Error::UnsupportedToken),
    }
}

/// Move `amount` from `from` into contract escrow, asserting the escrow balance
/// moved by exactly that much.
///
/// Mimir accounts in exact atomic USDC units. Fee-on-transfer and rebasing
/// assets would break escrow conservation, so reject them even if a
/// misconfigured deployment points `usdc` at such a token.
pub fn pull(env: &Env, usdc: &Address, from: &Address, amount: i128) -> Result<(), Error> {
    if amount <= 0 {
        return Err(Error::ZeroStake);
    }
    let client = token::TokenClient::new(env, usdc);
    let here = env.current_contract_address();
    let before = client.balance(&here);
    client.transfer(from, &here, &amount);
    if client.balance(&here) != before + amount {
        return Err(Error::UnsupportedToken);
    }
    Ok(())
}

/// Push a payout; park it on any failure.
///
/// On Base, a blacklisted USDC recipient makes `transfer` REVERT, which would
/// otherwise strand every other payout in the same `resolveClaim`. Soroban has
/// no blacklist, but a frozen or authorization-revoked trustline makes the SAC
/// transfer fail the same way — so the pull fallback is kept, using `try_` to
/// recover from the sub-call failure rather than propagating it.
pub fn push_or_park(env: &Env, usdc: &Address, to: &Address, amount: i128) {
    if amount == 0 {
        return;
    }
    let client = token::TokenClient::new(env, usdc);
    let here = env.current_contract_address();
    match client.try_transfer(&here, to, &amount) {
        Ok(Ok(())) => {}
        _ => {
            storage::add_withdrawable(env, to, amount);
            events::WithdrawalPending {
                to: to.clone(),
                amount,
            }
            .publish(env);
        }
    }
}

/// Push a payout, propagating failure. Used by the pull endpoints, where the
/// caller is the only party affected.
pub fn push(env: &Env, usdc: &Address, to: &Address, amount: i128) {
    let client = token::TokenClient::new(env, usdc);
    client.transfer(&env.current_contract_address(), to, &amount);
}

pub fn balance(env: &Env, usdc: &Address) -> i128 {
    token::TokenClient::new(env, usdc).balance(&env.current_contract_address())
}
