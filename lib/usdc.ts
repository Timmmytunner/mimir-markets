/**
 * Stellar Testnet USDC — the single Mimir asset.
 *
 * Market stakes, payouts and agent bankrolls are all denominated in Circle's
 * Testnet USDC, held and moved through its Stellar Asset Contract (SAC).
 * Transaction fees remain native XLM (see `lib/stellar.ts`).
 *
 * ── DECIMALS: 7, not 6 ───────────────────────────────────────────────────────
 *
 * The EVM-era version of this file used 6, because USDC as an ERC-20 is a
 * 6-decimal token. A Stellar Asset Contract exposes a classic asset with **7**
 * decimals, and this was confirmed by invoking `decimals()` on the live Testnet
 * SAC in `.env.local` (`CBIELTK6…HMXQDAMA`), which answers `7`, with
 * `name() = "USDC:GBBD47IF…3ZLLFLA5"` and `symbol() = "USDC"`.
 *
 * That matches `contracts-soroban/mimir-market/src/types.rs::MIN_STAKE`, which
 * is `2_0000000` (2 USDC at 7 decimals) — so the deployed contract's minimum is
 * correct and no redeploy is needed on this account.
 *
 * Every amount that crosses the contract boundary is an integer in these atomic
 * units. Display conversion happens at the edge, never in the accounting path.
 */
import {
  Account,
  Address,
  Asset,
  BASE_FEE,
  Contract,
  TransactionBuilder,
  rpc,
  scValToNative,
} from "@stellar/stellar-sdk";

import {
  NETWORK_PASSPHRASE,
  createSorobanRpcServer,
  getUsdcIssuer,
  getUsdcSacId,
  isAccountAddress,
  isContractAddress,
  isUsdcConfigured,
} from "./stellar";

/**
 * Circle's official Stellar Testnet USDC issuer. Verified against Horizon:
 * `home_domain: centre.io`, `auth_required: false`, `auth_revocable: true`.
 */
export const USDC_ISSUER =
  getUsdcIssuer() || "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

export const USDC_SYMBOL = "USDC";
export const USDC_CODE = "USDC";

/** Canonical `CODE:ISSUER` form, the id Horizon and the SAC's `name()` use. */
export const USDC_ASSET = `${USDC_CODE}:${USDC_ISSUER}`;

/**
 * The USDC Stellar Asset Contract id — what the market contract holds as its
 * escrow token and what a `transfer` is invoked on.
 *
 * Deliberately NOT called `USDC_ADDRESS`: the old name meant a 20-byte ERC-20
 * address and silently reusing it for a `C…` StrKey would let EVM-era call sites
 * keep compiling against a value they cannot use.
 */
export const USDC_SAC_ID = getUsdcSacId();

/** Decimals of the deployed SAC. Live-verified — see the module comment. */
export const USDC_DECIMALS = 7;

/** 1 USDC in atomic units. */
export const USDC_UNIT = 10_000_000n;

/** Strict 7-decimal parser. Financial boundaries pass the user's raw string. */
export function parseUsdcAtomic(input: string | number): bigint {
  const value = String(input).trim();
  if (!/^\d+(?:\.\d{1,7})?$/.test(value)) throw new Error("Invalid USDC amount");
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * USDC_UNIT + BigInt(fraction.padEnd(USDC_DECIMALS, "0"));
}

/** Exact decimal rendering for logs/API/UI; never passes through IEEE-754. */
export function formatAtomicUsdc(
  units: bigint | string,
  maxFractionDigits = USDC_DECIMALS,
): string {
  const value = typeof units === "bigint" ? units : BigInt(units);
  const sign = value < 0n ? "-" : "";
  const absolute = value < 0n ? -value : value;
  const whole = absolute / USDC_UNIT;
  const fraction = (absolute % USDC_UNIT)
    .toString()
    .padStart(USDC_DECIMALS, "0")
    .slice(0, Math.max(0, Math.min(USDC_DECIMALS, maxFractionDigits)))
    .replace(/0+$/, "");
  return `${sign}${whole}${fraction ? `.${fraction}` : ""}`;
}

/** Minimum stake in display USDC — mirrors `types.rs::MIN_STAKE = 2 * 10^7`. */
export const MIN_STAKE_USDC = 2;

/** The same minimum in atomic units, for direct comparison against chain reads. */
export const MIN_STAKE_ATOMIC = BigInt(MIN_STAKE_USDC) * USDC_UNIT;

/**
 * Convert display USDC to atomic units (7 decimals).
 * Supports up to 7 fractional digits.
 */
export function usdcToUnits(usdc: number): bigint {
  if (!Number.isFinite(usdc) || usdc < 0) throw new Error("Invalid USDC amount");
  return parseUsdcAtomic(usdc);
}

/** Convert atomic units to display USDC. */
export function unitsToUsdc(units: bigint | number): number {
  return Number(BigInt(units)) / Number(USDC_UNIT);
}

export function formatUsdcAmount(units: bigint | number, decimals = 2): string {
  return unitsToUsdc(units).toFixed(decimals) + " USDC";
}

// ── Live SAC reads ────────────────────────────────────────────────────────────

/**
 * The classic asset behind the SAC, for Horizon queries and `getSACBalance`.
 * A SAC wrapping a classic asset and the asset itself are the same balance;
 * this is what lets a Freighter user stake without an extra wrapping step.
 */
export function usdcAsset(): Asset {
  return new Asset(USDC_CODE, USDC_ISSUER);
}

/**
 * Read `decimals()` off the deployed SAC.
 *
 * Kept as a real call rather than trusting the constant: a SAC's decimals are
 * fixed by the asset it wraps, but the whole point of the migration bug this
 * module documents is that assuming was wrong once already. Callers that need
 * certainty (deploy verification, a decimals drift alarm) should invoke this and
 * compare against {@link USDC_DECIMALS}.
 */
export async function fetchUsdcDecimals(
  options: { server?: rpc.Server; sacId?: string } = {},
): Promise<number> {
  const sacId = options.sacId ?? USDC_SAC_ID;
  if (!sacId) throw new Error("NEXT_PUBLIC_STELLAR_USDC_SAC_ID is not set");

  // A simulated invocation rather than a generated client: the SAC interface is
  // fixed by the protocol, so there is no binding to generate, and simulation
  // needs a source account only to build an envelope. Nothing is signed or
  // submitted, so the issuer stands in as a guaranteed-to-exist source and no key
  // material is involved.
  const server = options.server ?? createSorobanRpcServer();
  const tx = new TransactionBuilder(new Account(USDC_ISSUER, "0"), {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(new Contract(sacId).call("decimals"))
    .setTimeout(30)
    .build();

  const simulated = await server.simulateTransaction(tx);
  if (!rpc.Api.isSimulationSuccess(simulated) || !simulated.result) {
    throw new Error(`USDC SAC decimals() simulation failed for ${sacId}`);
  }
  return Number(scValToNative(simulated.result.retval));
}

/**
 * A holder's USDC balance in atomic units, or null when they hold no trustline.
 *
 * Null and zero are deliberately distinct: "no trustline" is an actionable state
 * (the user must add one before they can be paid) while "zero balance" is not.
 */
export async function getUsdcBalanceUnits(
  address: string,
  options: { server?: rpc.Server } = {},
): Promise<bigint | null> {
  if (!isUsdcConfigured()) return null;
  const server = options.server ?? createSorobanRpcServer();
  try {
    const balance = await server.getSACBalance(address, usdcAsset());
    if (!balance.balanceEntry) return null;
    return BigInt(balance.balanceEntry.amount);
  } catch {
    return null;
  }
}

/**
 * Live SEP-41 SAC allowance read for (from, spender) in atomic units (7 decimals).
 * Returns null if unconfigured, if simulation fails, or if either address is invalid.
 */
export async function getUsdcAllowanceUnits(
  from: string,
  spender: string,
  options: { server?: rpc.Server; sacId?: string } = {},
): Promise<bigint | null> {
  const sacId = options.sacId ?? USDC_SAC_ID;
  if (!sacId || !isUsdcConfigured()) return null;
  const trimmedFrom = from?.trim() ?? "";
  const trimmedSpender = spender?.trim() ?? "";
  if (!isAccountAddress(trimmedFrom) && !isContractAddress(trimmedFrom)) return null;
  if (!isAccountAddress(trimmedSpender) && !isContractAddress(trimmedSpender)) return null;

  try {
    const server = options.server ?? createSorobanRpcServer();
    const tx = new TransactionBuilder(new Account(USDC_ISSUER, "0"), {
      fee: BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(
        new Contract(sacId).call(
          "allowance",
          new Address(trimmedFrom).toScVal(),
          new Address(trimmedSpender).toScVal(),
        ),
      )
      .setTimeout(30)
      .build();

    const simulated = await server.simulateTransaction(tx);
    if (!rpc.Api.isSimulationSuccess(simulated) || !simulated.result) {
      return null;
    }
    const val = scValToNative(simulated.result.retval);
    return typeof val === "bigint" ? val : BigInt(val);
  } catch {
    return null;
  }
}

