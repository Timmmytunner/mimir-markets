/**
 * Buyer side of Mimir's paid resources — x402 v2 over `@x402/fetch`.
 *
 * Two layers, mirroring how the agents think:
 *   1. createPayingFetch()  — a fetch that auto-pays any 402 it hits.
 *   2. fetchWithBudget()    — the agentic layer: refuse to pay at all when the
 *      quote exceeds the cap, so the agent walks away instead of overpaying.
 *
 * ── The cap is load-bearing here in a way it was not on EVM ──────────────────
 *
 * Under the EIP-3009 scheme this replaces, the buyer produced a SIGNATURE and a
 * facilitator turned it into a transfer, so an over-budget quote that slipped
 * through only cost a signature. Under the Stellar scheme
 * (`./stellar-scheme.ts`) the buyer SUBMITS ITS OWN PAYMENT, so by the time a
 * payload exists the money is gone. {@link budgetPolicy} therefore runs inside
 * the payment-requirements policy — before the scheme is ever asked for a
 * payload — and that ordering is the guard, not a nicety.
 */

import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { decodePaymentResponseHeader } from "@x402/core/http";
import type { PaymentPolicy } from "@x402/core/client";
import type { PaymentRequirements } from "@x402/core/types";

import { isPaused } from "../ops/flags";
import { X402_NETWORK } from "./config";
import { ExactStellarClient } from "./stellar-scheme";
import type { AgentWallet } from "../agent-wallets";

export function assertX402BuyingEnabled(address: string, env: Record<string, string | undefined> = process.env): void {
  // Not lowercased: the pause list now holds Stellar `G…` keys, which are
  // case-sensitive base32.
  const paused = new Set((env.MIMIR_PAUSED_X402_BUYERS ?? "").split(",").map((item) => item.trim()).filter(Boolean));
  // Through the shared switch, so MIMIR_PAUSE_ALL stops buying too: this path
  // submits its own payment, so a global pause that skipped it would still spend.
  if (isPaused("x402_buying", env) || paused.has(address.trim())) throw new Error("x402 buying paused");
}

export interface PayingWallet {
  /** The agent's `G…` account (payer). */
  address: string;
  /**
   * Builds an x402 client that pays `exact`/USDC quotes from this wallet.
   * A factory rather than one shared client: registerPolicy mutates the client,
   * and budget caps are per-purchase.
   */
  newClient: (policy?: PaymentPolicy) => x402Client;
}

/**
 * Wrap an agent wallet as an x402 buyer.
 *
 * The client registers exactly one scheme on exactly one network. That is not a
 * simplification — it is the guard that makes {@link budgetPolicy}'s network check
 * redundant rather than the only line of defence: `x402Client` filters a 402's
 * `accepts` down to registered scheme/network pairs before any policy runs, so a
 * quote for some other chain can never reach the paying scheme even if the policy
 * were removed.
 *
 * Every caller still treats a failed purchase as a MISSING INPUT rather than an
 * error — `lib/server/evidence-fetcher.ts` turns a throw into `null`, the oracle's
 * council vote falls back to a solo verdict, a persona abstains from a peer read,
 * a trader decides without its second opinion — and that contract is unchanged
 * now that the happy path works. It has to be: paying involves a live network,
 * a trustline the recipient may not hold, and a wallet that may be out of USDC,
 * so "could not buy this" stays a normal outcome rather than an exception.
 */
export function payingWalletFor(wallet: AgentWallet): PayingWallet {
  return {
    address: wallet.address,
    newClient: (policy?: PaymentPolicy) => {
      const client = new x402Client().register(X402_NETWORK, new ExactStellarClient(wallet));
      if (policy) client.registerPolicy(policy);
      return client;
    },
  };
}

export interface PaidFetchResult {
  response: Response;
  /** Null when the resource was free (no 402). */
  payment: {
    /** Settled amount in USDC atomic units (7 decimals). */
    priceUnits: bigint;
    /** The Stellar transaction hash the payment landed in. */
    txHash: string;
  } | null;
}

export class PaymentBudgetExceeded extends Error {
  constructor(
    readonly priceUnits: bigint,
    readonly capUnits: bigint,
  ) {
    super(`payment price ${priceUnits} USDC atomic units exceeds budget cap ${capUnits}`);
    this.name = "PaymentBudgetExceeded";
  }
}

/**
 * Reject any quote on the wrong network, or above the cap, before paying.
 *
 * `onRefusal` exists because `@x402/fetch` does NOT propagate what a policy
 * throws: `wrapFetchWithPayment` catches it and rethrows a plain
 * `Error("Failed to create payment payload: …")` with no `cause`. Recording the
 * refusal here is the only way {@link fetchWithBudget} can honour its documented
 * contract of throwing {@link PaymentBudgetExceeded} — which callers need in
 * order to tell "too expensive, walked away" apart from "the endpoint is broken".
 */
function budgetPolicy(capUnits: bigint, onRefusal: (error: PaymentBudgetExceeded) => void): PaymentPolicy {
  return (_version: number, accepts: PaymentRequirements[]): PaymentRequirements[] => {
    const onNetwork = accepts.filter((r) => r.network === X402_NETWORK);
    if (onNetwork.length === 0) {
      throw new Error(
        `402 quote targets unsupported network(s) ${accepts.map((r) => r.network).join(", ")}`,
      );
    }
    const affordable = onNetwork.filter((r) => BigInt(r.amount) <= capUnits);
    if (affordable.length === 0) {
      // The agentic decision point: cheapest quote still too expensive, walk away
      // WITHOUT SUBMITTING A PAYMENT. Throwing here — inside the requirements
      // policy — is what keeps the money in the wallet, because the scheme's
      // createPaymentPayload is only reached after a requirement survives this.
      const cheapest = onNetwork.reduce(
        (min, r) => (BigInt(r.amount) < min ? BigInt(r.amount) : min),
        BigInt(onNetwork[0].amount),
      );
      const refusal = new PaymentBudgetExceeded(cheapest, capUnits);
      onRefusal(refusal);
      throw refusal;
    }
    return affordable;
  };
}

/** Settlement metadata the seller returns on a paid 200. */
function readSettlement(response: Response) {
  const header = response.headers.get("payment-response");
  if (!header) return null;
  try {
    const settled = decodePaymentResponseHeader(header);
    if (!settled.success) return null;
    return {
      priceUnits: BigInt(settled.amount ?? "0"),
      txHash: settled.transaction || "",
    };
  } catch {
    return null;
  }
}

/**
 * A fetch that automatically pays any 402 it encounters. No budget guard — use
 * fetchWithBudget for the agentic, capped path.
 */
export function createPayingFetch(wallet: PayingWallet): typeof globalThis.fetch {
  assertX402BuyingEnabled(wallet.address);
  return wrapFetchWithPayment(fetch, wallet.newClient()) as typeof globalThis.fetch;
}

/**
 * Agentic pay-per-request: the cap is enforced inside the requirements policy, so
 * an over-budget quote is never paid.
 *
 * @param url        resource to fetch
 * @param wallet     paying agent wallet
 * @param capUnits   hard budget cap in USDC atomic units (1 USDC = 10_000_000 —
 *                   Stellar USDC has 7 decimals, see lib/usdc.ts).
 *                   Throws PaymentBudgetExceeded when the quote is higher.
 * @param init       passthrough fetch init
 */
export async function fetchWithBudget(
  url: string,
  wallet: PayingWallet,
  capUnits: bigint,
  init?: RequestInit,
): Promise<PaidFetchResult> {
  assertX402BuyingEnabled(wallet.address);
  let refusal: PaymentBudgetExceeded | null = null;
  const payingFetch = wrapFetchWithPayment(
    fetch,
    wallet.newClient(budgetPolicy(capUnits, (error) => { refusal = error; })),
  );
  let response: Response;
  try {
    response = await payingFetch(url, init);
  } catch (error) {
    // Unwrap the SDK's generic rethrow so the cap refusal keeps its type.
    throw refusal ?? error;
  }
  return { response, payment: readSettlement(response) };
}
