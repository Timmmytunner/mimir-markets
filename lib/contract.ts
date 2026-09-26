/**
 * Mimir contract client (Stellar Testnet / Soroban).
 *
 * Everything here goes through the generated bindings in `sdk/contracts/*` — the
 * verbatim output of `stellar contract bindings typescript`. No hand-written
 * contract spec, no hand-rolled XDR: a contract change is a `npm run
 * stellar:bindings` away from being a type error here.
 *
 * Market stakes are USDC through its Stellar Asset Contract (7 decimals — see
 * `lib/usdc.ts`). Transaction fees are native XLM.
 *
 * ── What changed versus the EVM client this replaces ─────────────────────────
 *
 *  - **No allowance step.** The ERC-20 `approve` + `transferFrom` dance is gone.
 *    Soroban authorization is per-invocation: `create_claim` and
 *    `challenge_claim` carry a signed auth entry that permits exactly one USDC
 *    `transfer` of exactly the staked amount. There is no standing allowance to
 *    grant, and therefore no two-transaction path and no atomic-batch
 *    workaround — one signature covers the stake and the call.
 *
 *  - **Settlement is pull-based for challengers.** `resolve_claim` no longer pays
 *    everyone: a Stellar transaction is capped on its ledger-entry footprint, so
 *    paying ~100 challengers cannot fit in one call. Each challenger now pulls
 *    with {@link claimChallengerPayout}; {@link quoteChallengerPayout} previews
 *    it. See `contracts-soroban/mimir-market/src/resolve.rs`.
 *
 *  - **Writes need a signer, not just an address.** There is no ambient
 *    `window.ethereum` equivalent, so write functions accept a
 *    {@link StellarSigner} (the shape `@creit.tech/stellar-wallets-kit` already
 *    returns) as their `wallet` argument. The parameter still accepts a bare
 *    address string so existing call sites type-check unchanged; passing one
 *    throws a clear "connect a wallet" error at call time, and the wallet layer
 *    phase replaces those call sites with real signers.
 *
 *  - **`createClaim` returns the real id.** `create_claim` returns the new claim
 *    id directly, so the old "read `claimCount` afterwards and hope" heuristic is
 *    gone.
 */
import { Buffer } from "buffer";

import { MimirMarket, MimirSquad } from "@/sdk/contracts";

import {
  STELLAR_READ_CONCURRENCY,
  createSorobanRpcServer,
  getExplorerTxUrl,
  getMarketContractId,
  getSquadContractId,
  isMarketConfigured,
  isStellarSigner,
  requireMarketContractId,
  requireSquadContractId,
  stellarClientOptions,
  type StellarSigner,
} from "./stellar";
import { MIN_STAKE_USDC, unitsToUsdc, usdcToUnits } from "./usdc";
import { normalizeCategoryId, ZERO_ADDRESS } from "./constants";
import { guardChallenge, toCanonicalMode } from "./market-modes";
import { checkWriteAllowed } from "./ops/flags";
import { availableCreatorLiquidityUnits } from "./payout";
import { decodeHash32Hex } from "./content-hash";
import type { VSCacheFreshness } from "./vs-freshness";

export type { StellarSigner } from "./stellar";

// ── Constants ─────────────────────────────────────────────────────────────────
// MIN_STAKE in display USDC (mirrors types.rs: MIN_STAKE = 2 * 10^7 = 2 USDC).
export { MIN_STAKE_USDC as MIN_STAKE };

/**
 * The market contract id. Named `CONTRACT_ADDRESS` for call-site compatibility;
 * the value is a Soroban `C…` StrKey, not a 20-byte address.
 */
export const CONTRACT_ADDRESS = getMarketContractId();

/** Basis-point divisor for the fixed-odds math. Mirrors `types.rs::BPS_DIVISOR`. */
export const BPS_DIVISOR = 10_000;

/**
 * Numeric mirrors of the on-chain enums, kept as plain objects so the values can
 * be compared against indexed/serialised data that has lost the enum type. The
 * discriminants match `types.rs` exactly.
 */
export const STATE = {
  OPEN: MimirMarket.ClaimState.Open,
  ACTIVE: MimirMarket.ClaimState.Active,
  RESOLVED: MimirMarket.ClaimState.Resolved,
  CANCELLED: MimirMarket.ClaimState.Cancelled,
} as const;

export const WINNER_SIDE = {
  NONE: MimirMarket.WinnerSide.None,
  CREATOR: MimirMarket.WinnerSide.Creator,
  CHALLENGERS: MimirMarket.WinnerSide.Challengers,
  DRAW: MimirMarket.WinnerSide.Draw,
  UNRESOLVABLE: MimirMarket.WinnerSide.Unresolvable,
} as const;

/**
 * Mirrors `types.rs::CHALLENGE_LOCK_SECONDS` — challenges must arrive at least
 * this long before the deadline or the call fails with `ChallengeWindowClosed`.
 */
export const VS_CHALLENGE_LOCK_SECONDS = 60;

/** 32 zero bytes — the `context_hash` of a market with no attached research. */
const ZERO_HASH32 = Buffer.alloc(32);

// ── Interfaces ────────────────────────────────────────────────────────────────
export interface ClaimChallenger {
  address: string;
  stake: number;
  potential_payout: number;
  /** True once this challenger has pulled their settlement. */
  claimed?: boolean;
}

export interface ClaimData {
  id: number;
  creator: string;
  question: string;
  creator_position: string;
  counter_position: string;
  resolution_url: string;
  creator_stake: number;
  total_challenger_stake: number;
  reserved_creator_liability: number;
  available_creator_liability: number;
  deadline: number;
  state: "open" | "active" | "resolved" | "cancelled";
  winner_side: "creator" | "challengers" | "draw" | "unresolvable" | "";
  resolution_summary: string;
  confidence: number;
  category: string;
  parent_id: number;
  challenger_count: number;
  market_type: string;
  odds_mode: string;
  challenger_payout_bps: number;
  handicap_line: string;
  settlement_rule: string;
  max_challengers: number;
  created_at?: number;
  visibility?: "public" | "private";
  is_private?: boolean;
  challengers?: ClaimChallenger[];
  first_challenger?: string;
  challenger_addresses?: string[];
  total_pot: number;
  /** Hex of the oracle evidence hash — the on-chain reasoning trace. */
  evidence_hash?: string;
  /** Hex of the research context hash snapshotted at creation. */
  context_hash?: string;
  /** Escrow still owed to challengers after resolution, display USDC. */
  remaining_escrow?: number;
  /** How many challengers have already pulled their settlement. */
  challenger_claims?: number;
  /** @deprecated not used — the oracle resolves automatically */
  resolve_attempts?: number;
  /** @deprecated not used — the oracle resolves automatically */
  creator_requested_resolve?: boolean;
  /** @deprecated not used — the oracle resolves automatically */
  challenger_requested_resolve?: boolean;
}

export interface VSData {
  id: number;
  creator: string;
  opponent: string;
  question: string;
  creator_position: string;
  opponent_position: string;
  resolution_url: string;
  stake_amount: number;
  deadline: number;
  state: "open" | "accepted" | "resolved" | "cancelled";
  winner: string;
  resolution_summary: string;
  created_at?: number;
  category: string;
  challengers?: ClaimChallenger[];
  counter_position?: string;
  creator_stake?: number;
  total_challenger_stake?: number;
  reserved_creator_liability?: number;
  available_creator_liability?: number;
  winner_side?: ClaimData["winner_side"];
  confidence?: number;
  parent_id?: number;
  challenger_count?: number;
  market_type?: string;
  odds_mode?: string;
  challenger_payout_bps?: number;
  handicap_line?: string;
  settlement_rule?: string;
  max_challengers?: number;
  visibility?: ClaimData["visibility"];
  is_private?: boolean;
  total_pot?: number;
  challenger_addresses?: string[];
  remaining_escrow?: number;
  challenger_claims?: number;
  // Resolution-request flow (optional, surfaces off-chain UI state)
  creator_requested_resolve?: boolean;
  challenger_requested_resolve?: boolean;
  resolve_attempts?: number;
}

export interface CreateClaimParams {
  question: string;
  creator_position: string;
  counter_position: string;
  resolution_url: string;
  deadline: number;
  stake_amount: number;         // whole USDC (e.g. 5 = 5 USDC)
  category?: string;
  parent_id?: number;
  market_type?: string;
  odds_mode?: string;
  challenger_payout_bps?: number;
  handicap_line?: string;
  settlement_rule?: string;
  max_challengers?: number;
  visibility?: "public" | "private";
  invite_key?: string;
  /** `G…`/`C…` address credited with the agent-owner fee, when attributed. */
  agent_owner_recipient?: string | null;
  /** 32-byte research context hash, hex. */
  context_hash?: string;
}

export interface ContractWriteResult {
  txHash: string;
  explorerUrl?: string;
  /** @deprecated use explorerUrl */
  explorerTxHash?: string;
  receipt: unknown;
  pending?: boolean;
}

export interface ClaimWriteResult extends ContractWriteResult {
  claimId: number | null;
}

export interface VSFeedSnapshot {
  items: VSData[];
  cache: VSCacheFreshness | null;
}

export interface VSDetailSnapshot {
  item: VSData | null;
  cache: VSCacheFreshness | null;
}

/** A wallet argument: a real signer, or a bare address for legacy call sites. */
export type WalletArg = string | StellarSigner;

// ── State / side mappers ──────────────────────────────────────────────────────
function mapState(state: MimirMarket.ClaimState): ClaimData["state"] {
  switch (state) {
    case MimirMarket.ClaimState.Open:      return "open";
    case MimirMarket.ClaimState.Active:    return "active";
    case MimirMarket.ClaimState.Resolved:  return "resolved";
    case MimirMarket.ClaimState.Cancelled: return "cancelled";
    default: return "open";
  }
}

function mapWinnerSide(side: MimirMarket.WinnerSide): ClaimData["winner_side"] {
  switch (side) {
    case MimirMarket.WinnerSide.Creator:      return "creator";
    case MimirMarket.WinnerSide.Challengers:  return "challengers";
    case MimirMarket.WinnerSide.Draw:         return "draw";
    case MimirMarket.WinnerSide.Unresolvable: return "unresolvable";
    default: return "";
  }
}

function toWinnerSide(verdict: ClaimData["winner_side"]): MimirMarket.WinnerSide {
  switch (verdict) {
    case "creator":      return MimirMarket.WinnerSide.Creator;
    case "challengers":  return MimirMarket.WinnerSide.Challengers;
    case "draw":         return MimirMarket.WinnerSide.Draw;
    case "unresolvable": return MimirMarket.WinnerSide.Unresolvable;
    default: throw new Error(`Cannot resolve a claim to "${verdict || "none"}"`);
  }
}

// ── Result unwrapping ─────────────────────────────────────────────────────────
/**
 * A Soroban `Err` comes back INSIDE the simulation result as a Rust-style
 * `Result`, not as a thrown exception, so an unwrapped call reports success on a
 * contract error. Every `Result<T>` return therefore goes through here.
 */
function unwrap<T>(label: string, result: unknown): T {
  if (result && typeof result === "object" && "isOk" in result) {
    const rustResult = result as { isOk(): boolean; unwrap(): T; error?: unknown };
    if (!rustResult.isOk()) {
      const error = rustResult.error;
      const message =
        error && typeof error === "object" && "message" in error
          ? String((error as { message: unknown }).message)
          : JSON.stringify(error);
      throw new Error(`${label}: ${message}`);
    }
    return rustResult.unwrap();
  }
  return result as T;
}

/** Same, but a contract error becomes `null` — for "does this exist" reads. */
function unwrapOrNull<T>(result: unknown): T | null {
  if (result && typeof result === "object" && "isOk" in result) {
    const rustResult = result as { isOk(): boolean; unwrap(): T };
    return rustResult.isOk() ? rustResult.unwrap() : null;
  }
  return (result ?? null) as T | null;
}

// ── Clients ───────────────────────────────────────────────────────────────────
let _readMarket: MimirMarket.Client | null = null;

/** Read-only market client, memoised per process. */
function marketReader(): MimirMarket.Client {
  if (!_readMarket) {
    _readMarket = new MimirMarket.Client(stellarClientOptions(requireMarketContractId()));
  }
  return _readMarket;
}

let _readSquad: MimirSquad.Client | null = null;

function squadReader(): MimirSquad.Client {
  if (!_readSquad) {
    _readSquad = new MimirSquad.Client(stellarClientOptions(requireSquadContractId()));
  }
  return _readSquad;
}

/**
 * Resolve a wallet argument into a signer, or explain why it cannot be.
 *
 * A bare address is accepted by the type so pre-migration call sites still
 * compile; it cannot sign, so it fails here with a message a user can act on
 * rather than an opaque XDR error deeper in the SDK.
 */
function requireSigner(wallet: WalletArg, action: string): StellarSigner {
  if (isStellarSigner(wallet)) return wallet;
  throw new Error(
    `Cannot ${action}: no Stellar wallet signer was provided. Connect a wallet first.`,
  );
}

/** Signing-capable market client bound to `signer`. */
function marketWriter(signer: StellarSigner): MimirMarket.Client {
  return new MimirMarket.Client({
    ...stellarClientOptions(requireMarketContractId()),
    publicKey: signer.publicKey,
    signTransaction: signer.signTransaction,
    ...(signer.signAuthEntry ? { signAuthEntry: signer.signAuthEntry } : {}),
  });
}

function squadWriter(signer: StellarSigner): MimirSquad.Client {
  return new MimirSquad.Client({
    ...stellarClientOptions(requireSquadContractId()),
    publicKey: signer.publicKey,
    signTransaction: signer.signTransaction,
    ...(signer.signAuthEntry ? { signAuthEntry: signer.signAuthEntry } : {}),
  });
}

/**
 * Sign, submit and unwrap one contract call.
 *
 * Returns the transaction hash alongside the decoded value: a settled Stellar
 * transaction is final on inclusion (no reorgs, no confirmation count), so a
 * successful `signAndSend` is the whole receipt.
 */
async function sendCall<T>(
  label: string,
  assembled: {
    signAndSend: () => Promise<{
      result: unknown;
      sendTransactionResponse?: { hash: string } | undefined;
      getTransactionResponse?: unknown;
    }>;
  },
): Promise<{ value: T; write: ContractWriteResult }> {
  const sent = await assembled.signAndSend();
  const txHash = sent.sendTransactionResponse?.hash ?? "";
  const explorerUrl = txHash ? getExplorerTxUrl(txHash) : undefined;
  const value = unwrap<T>(label, sent.result);
  return {
    value,
    write: {
      txHash,
      explorerUrl,
      explorerTxHash: explorerUrl,
      receipt: sent.getTransactionResponse ?? null,
      pending: !sent.getTransactionResponse,
    },
  };
}

// ── Bulk-read concurrency limiter ─────────────────────────────────────────────
// Every claim costs 2 simulated invocations (get_claim + get_challenger_list), so
// `Promise.all` over 100+ claims is ~200 parallel requests and the public RPC
// throttles. All bulk claim reads funnel through here instead.
async function mapWithConcurrency<T, R>(
  items: T[],
  fn: (item: T, index: number) => Promise<R>,
  concurrency = STELLAR_READ_CONCURRENCY,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workerCount = Math.min(Math.max(1, concurrency), Math.max(1, items.length));
  async function worker() {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

async function readClaimsRange(startId: number, count: number): Promise<(ClaimData | null)[]> {
  const ids = Array.from({ length: count }, (_, i) => startId + i);
  return mapWithConcurrency(ids, (id) => readClaimRaw(id));
}

// ── Raw on-chain read ─────────────────────────────────────────────────────────
const READ_CLAIM_RETRY_ATTEMPTS = 3;
const READ_CLAIM_RETRY_BASE_MS = 200;

function toHex(bytes: Buffer | Uint8Array | undefined | null): string | undefined {
  if (!bytes || bytes.length === 0) return undefined;
  const hex = Buffer.from(bytes).toString("hex");
  return /^0+$/.test(hex) ? undefined : hex;
}

function fromHex32(hex: string | undefined | null, field = "hash"): Buffer {
  return hex ? decodeHash32Hex(hex, field) : ZERO_HASH32;
}

/**
 * Read one claim plus its challenger roster.
 *
 * The Soroban `get_claim` returns the whole `Claim` struct — market config
 * included — so this is two calls where the EVM client needed three, and there is
 * no positional tuple to decode: the binding hands back named fields, which is
 * why the old `lib/claim-codec.ts` indirection is not needed on this path.
 */
export async function readClaimRaw(claimId: number): Promise<ClaimData | null> {
  if (!isMarketConfigured()) return null;
  const client = marketReader();

  let claim: MimirMarket.Claim | null = null;
  let roster: MimirMarket.Challenger[] = [];

  let lastError: unknown = null;
  for (let attempt = 0; attempt < READ_CLAIM_RETRY_ATTEMPTS; attempt += 1) {
    try {
      const [claimTx, rosterTx] = await Promise.all([
        client.get_claim({ claim_id: BigInt(claimId) }),
        client.get_challenger_list({ claim_id: BigInt(claimId) }),
      ]);
      claim = unwrapOrNull<MimirMarket.Claim>(claimTx.result);
      roster = rosterTx.result ?? [];
      lastError = null;
      break;
    } catch (err) {
      lastError = err;
      if (attempt < READ_CLAIM_RETRY_ATTEMPTS - 1) {
        const backoff = READ_CLAIM_RETRY_BASE_MS * Math.pow(2, attempt);
        await new Promise((resolve) => setTimeout(resolve, backoff));
      }
    }
  }

  if (lastError) {
    console.warn(
      `[readClaimRaw] claim ${claimId} failed after ${READ_CLAIM_RETRY_ATTEMPTS} attempts`,
      lastError,
    );
    return null;
  }
  // A missing claim is `Err(ClaimNotFound)`, not a throw — an absent claim is a
  // normal answer when a feed walks past the end of the range.
  if (!claim) return null;

  try {
    return decodeClaim(claimId, claim, roster);
  } catch (err) {
    console.warn(`[readClaimRaw] decode failed for claim ${claimId}`, err);
    return null;
  }
}

/** Map the on-chain `Claim` struct + roster onto the app's `ClaimData`. */
export function decodeClaim(
  claimId: number,
  claim: MimirMarket.Claim,
  roster: MimirMarket.Challenger[] = [],
): ClaimData {
  const creatorStakeUsdc = unitsToUsdc(claim.creator_stake);
  const totalChStakeUsdc = unitsToUsdc(claim.total_challenger_stake);
  const reservedUsdc = unitsToUsdc(claim.reserved_creator_liability);

  const payBps = Number(claim.market.challenger_payout_bps);
  const isFixed = claim.market.odds_mode === "fixed";

  const challengers: ClaimChallenger[] = roster.map((entry) => {
    const stake = unitsToUsdc(entry.stake);
    const payout = isFixed
      ? (stake * payBps) / BPS_DIVISOR
      : stake + (totalChStakeUsdc > 0 ? (stake / totalChStakeUsdc) * creatorStakeUsdc : 0);
    return { address: entry.address, stake, potential_payout: payout, claimed: entry.claimed };
  });

  const addresses = challengers.map((entry) => entry.address);
  const availLiab = Math.max(0, creatorStakeUsdc - reservedUsdc);

  return {
    id:                          claimId,
    creator:                     claim.creator,
    question:                    claim.question,
    creator_position:            claim.creator_position,
    counter_position:            claim.counter_position,
    resolution_url:              claim.resolution_url,
    creator_stake:               creatorStakeUsdc,
    total_challenger_stake:      totalChStakeUsdc,
    reserved_creator_liability:  reservedUsdc,
    available_creator_liability: availLiab,
    deadline:                    Number(claim.deadline),
    state:                       mapState(claim.state),
    winner_side:                 mapWinnerSide(claim.winner_side),
    resolution_summary:          claim.resolution_summary,
    confidence:                  Number(claim.confidence),
    category:                    normalizeCategoryId(claim.category),
    parent_id:                   Number(claim.parent_id),
    challenger_count:            Number(claim.challenger_count),
    created_at:                  Number(claim.created_at),
    evidence_hash:               toHex(claim.evidence_hash ?? undefined),
    context_hash:                toHex(claim.context_hash),
    remaining_escrow:            unitsToUsdc(claim.remaining_escrow),
    challenger_claims:           Number(claim.challenger_claims),
    market_type:                 claim.market.market_type,
    odds_mode:                   claim.market.odds_mode,
    challenger_payout_bps:       payBps,
    handicap_line:               claim.market.handicap_line,
    settlement_rule:             claim.market.settlement_rule,
    max_challengers:             Number(claim.market.max_challengers),
    visibility:                  claim.market.is_private ? "private" : "public",
    is_private:                  claim.market.is_private,
    challengers,
    first_challenger:            addresses[0] ?? ZERO_ADDRESS,
    challenger_addresses:        addresses,
    total_pot:                   creatorStakeUsdc + totalChStakeUsdc,
  };
}

// ── Public read functions ─────────────────────────────────────────────────────
export async function getClaim(claimId: number): Promise<ClaimData | null> {
  return readClaimRaw(claimId);
}

export async function getClaimCount(): Promise<number> {
  if (!isMarketConfigured()) return 0;
  const stats = await getPlatformStats();
  return stats.total_claims;
}

/** The challenger roster for a claim, including who has already been paid. */
export async function getChallengerList(claimId: number): Promise<ClaimChallenger[]> {
  const claim = await readClaimRaw(claimId);
  return claim?.challengers ?? [];
}

export async function getVSSummaries(startId: number, limit: number): Promise<VSData[]> {
  const results = await readClaimsRange(startId, limit);
  return (results.filter(Boolean) as ClaimData[]).map(mapClaimToVS);
}

export async function getUserVSSummaries(address: string): Promise<VSData[]> {
  const count = await getClaimCount();
  if (count <= 0) return [];

  const all = await readClaimsRange(1, count);
  return all
    .filter((c): c is ClaimData => Boolean(c) && isClaimParticipant(c!, address))
    .map(mapClaimToVS);
}

/**
 * Win/loss record for an address.
 *
 * DEVIATION: the EVM contract kept `userWins`/`userLosses` counters on chain and
 * exposed `getUserStats`. The Soroban contract deliberately does not — per-address
 * tallies cost a storage write per settlement and are derivable from the
 * `ClaimResolved` / `ChallengerPaid` events (see the note on `ChallengerPaid` in
 * the bindings). Until the indexer derives them from events, this walks the
 * claims the address participated in, which is correct but O(claims).
 */
export async function getUserStats(address: string): Promise<{ wins: number; losses: number }> {
  const claims = await getUserClaimSummaries(address);
  let wins = 0;
  let losses = 0;
  for (const claim of claims) {
    if (claim.state !== "resolved") continue;
    const vs = mapClaimToVS(claim);
    if (didUserWinVS(vs, address)) wins += 1;
    else if (didUserLoseVS(vs, address)) losses += 1;
  }
  return { wins, losses };
}

export async function getPlatformStats(): Promise<{
  total_claims: number;
  total_resolved: number;
  total_pool: number;
  fees_accrued: number;
  fees_claimed: number;
}> {
  if (!isMarketConfigured()) {
    return { total_claims: 0, total_resolved: 0, total_pool: 0, fees_accrued: 0, fees_claimed: 0 };
  }
  const tx = await marketReader().get_platform_stats();
  const stats = unwrap<MimirMarket.PlatformStats>("get_platform_stats", tx.result);
  return {
    total_claims:   Number(stats.total_claims),
    total_resolved: Number(stats.resolved),
    total_pool:     unitsToUsdc(stats.balance),
    fees_accrued:   unitsToUsdc(stats.fees_accrued),
    fees_claimed:   unitsToUsdc(stats.fees_claimed),
  };
}

/** The fee policy snapshotted onto one claim at creation. */
export async function getClaimFees(claimId: number): Promise<{
  platform_fee_bps: number;
  agent_owner_fee_bps: number;
  platform_recipient: string | null;
  agent_owner_recipient: string | null;
  context_hash?: string;
} | null> {
  if (!isMarketConfigured()) return null;
  const tx = await marketReader().get_claim_fees({ claim_id: BigInt(claimId) });
  const view = unwrapOrNull<MimirMarket.ClaimFeeView>(tx.result);
  if (!view) return null;
  return {
    platform_fee_bps:      Number(view.platform_fee_bps),
    agent_owner_fee_bps:   Number(view.agent_owner_fee_bps),
    platform_recipient:    view.platform_recipient ?? null,
    agent_owner_recipient: view.agent_owner_recipient ?? null,
    context_hash:          toHex(view.context_hash),
  };
}

/** The live, contract-wide fee policy (not the per-claim snapshot). */
export async function getFeePolicy(): Promise<{
  platform_fee_bps: number;
  agent_owner_fee_bps: number;
  platform_recipient: string | null;
} | null> {
  if (!isMarketConfigured()) return null;
  const tx = await marketReader().get_fee_policy();
  const policy = unwrapOrNull<MimirMarket.FeePolicy>(tx.result);
  if (!policy) return null;
  return {
    platform_fee_bps:    Number(policy.platform_fee_bps),
    agent_owner_fee_bps: Number(policy.agent_owner_fee_bps),
    platform_recipient:  policy.platform_recipient ?? null,
  };
}

/** The address allowed to call `resolve_claim`. `null` when unreadable. */
export async function getOracle(): Promise<string | null> {
  if (!isMarketConfigured()) return null;
  const tx = await marketReader().get_oracle();
  return unwrapOrNull<string>(tx.result);
}

/** The contract owner — fee policy and oracle rotation. `null` when unreadable. */
export async function getOwner(): Promise<string | null> {
  if (!isMarketConfigured()) return null;
  const tx = await marketReader().get_owner();
  return unwrapOrNull<string>(tx.result);
}

/**
 * The fee policy that has been announced but is still inside its timelock.
 *
 * `null` when nothing is queued. `executable_at` is a UNIX SECOND (Soroban's
 * `env.ledger().timestamp()`), not a block number — there is no block height to
 * compare against, so a caller checks it against the wall clock.
 */
export async function getPendingFeePolicy(): Promise<{
  platform_fee_bps: number;
  agent_owner_fee_bps: number;
  platform_recipient: string | null;
  executable_at: number;
  /** True once the timelock has elapsed and `executeFeePolicy` will succeed. */
  ready: boolean;
} | null> {
  if (!isMarketConfigured()) return null;
  const tx = await marketReader().get_pending_fee_policy();
  const pending = tx.result ?? null;
  if (!pending) return null;
  const executableAt = Number(pending.executable_at);
  return {
    platform_fee_bps:    Number(pending.platform_fee_bps),
    agent_owner_fee_bps: Number(pending.agent_owner_fee_bps),
    platform_recipient:  pending.platform_recipient ?? null,
    executable_at:       executableAt,
    ready:               Date.now() >= executableAt * 1000,
  };
}

/**
 * Announce a fee-policy change. Owner only; starts the timelock.
 *
 * The contract enforces a notice period between queueing and executing, which is
 * why this and {@link executeFeePolicy} are two calls rather than one.
 */
export async function queueFeePolicy(
  wallet: WalletArg,
  params: {
    platform_fee_bps: number;
    agent_owner_fee_bps: number;
    /** `G…`/`C…` recipient, or null to leave fees unassigned. */
    platform_recipient?: string | null;
  },
): Promise<ContractWriteResult> {
  const signer = requireSigner(wallet, "queue a fee policy");
  const { write } = await sendCall<void>(
    "queue_fee_policy",
    await marketWriter(signer).queue_fee_policy({
      platform_fee_bps:    params.platform_fee_bps,
      agent_owner_fee_bps: params.agent_owner_fee_bps,
      platform_recipient:  params.platform_recipient ?? undefined,
    }),
  );
  return write;
}

/**
 * Apply a queued policy once its timelock has elapsed.
 *
 * Permissionless on purpose: a lost owner key must not be able to strand a change
 * that was already announced.
 */
export async function executeFeePolicy(wallet: WalletArg): Promise<ContractWriteResult> {
  const signer = requireSigner(wallet, "execute the queued fee policy");
  const { write } = await sendCall<void>(
    "execute_fee_policy",
    await marketWriter(signer).execute_fee_policy(),
  );
  return write;
}

/** Drop a queued policy before it executes. Owner only. */
export async function cancelFeePolicy(wallet: WalletArg): Promise<ContractWriteResult> {
  const signer = requireSigner(wallet, "cancel the queued fee policy");
  const { write } = await sendCall<void>(
    "cancel_fee_policy",
    await marketWriter(signer).cancel_fee_policy(),
  );
  return write;
}

/** Parked funds owed to `address` because a payout push failed. Display USDC. */
export async function getWithdrawable(address: string): Promise<number> {
  if (!isMarketConfigured()) return 0;
  const tx = await marketReader().get_withdrawable({ who: address });
  return unitsToUsdc(tx.result ?? 0n);
}

/** Accrued, unclaimed fees owed to `address`. Display USDC. */
export async function getAccruedFees(address: string): Promise<number> {
  if (!isMarketConfigured()) return 0;
  const tx = await marketReader().get_accrued_fees({ who: address });
  return unitsToUsdc(tx.result ?? 0n);
}

/**
 * What {@link claimChallengerPayout} would pay this challenger right now.
 *
 * NEW: has no EVM counterpart, because the EVM contract paid challengers inside
 * `resolveClaim` and there was nothing to quote.
 */
export async function quoteChallengerPayout(
  claimId: number,
  challenger: string,
): Promise<{ gross: number; fee: number; net: number; claimed: boolean } | null> {
  if (!isMarketConfigured()) return null;
  const tx = await marketReader().quote_challenger_payout({
    claim_id: BigInt(claimId),
    challenger,
  });
  const quote = unwrapOrNull<MimirMarket.PayoutQuote>(tx.result);
  if (!quote) return null;
  return {
    gross:   unitsToUsdc(quote.gross),
    fee:     unitsToUsdc(quote.fee),
    net:     unitsToUsdc(quote.net),
    claimed: quote.claimed,
  };
}

// ── Fast feed (browser uses /api/vs, server reads directly) ──────────────────
export async function getAllVSFast(): Promise<VSFeedSnapshot> {
  if (typeof window !== "undefined") {
    const res = await fetch("/api/vs");
    if (!res.ok) throw new Error(`/api/vs returned ${res.status}`);
    const data = await res.json();
    return { items: data.items ?? [], cache: data.cache ?? null };
  }
  return getAllVSDirect();
}

export async function getAllVSDirect(): Promise<VSFeedSnapshot> {
  const count = await getClaimCount();
  if (count <= 0) return { items: [], cache: makeLiveFreshness() };

  const all = await readClaimsRange(1, count);
  return {
    items: (all.filter(Boolean) as ClaimData[])
      .map(mapClaimToVS)
      .sort((a, b) => b.id - a.id),
    cache: makeLiveFreshness(),
  };
}

export async function getUserVSFast(address: string): Promise<VSFeedSnapshot> {
  if (typeof window !== "undefined") {
    const res = await fetch(`/api/vs/user/${address}`);
    if (!res.ok) throw new Error(`/api/vs/user returned ${res.status}`);
    const data = await res.json();
    return { items: data.items ?? [], cache: data.cache ?? null };
  }
  const items = await getUserVSSummaries(address);
  return { items: items.sort((a, b) => b.id - a.id), cache: makeLiveFreshness() };
}

/** Returns VSData | null directly (backwards compatible). */
export async function getVS(
  vsId: number,
  opts?: { inviteKey?: string; viewerAddress?: string }
): Promise<VSData | null> {
  if (typeof window !== "undefined") {
    const url = opts?.inviteKey
      ? `/api/vs/${vsId}?invite=${encodeURIComponent(opts.inviteKey)}`
      : `/api/vs/${vsId}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    return data.item ?? null;
  }
  const claim = await readClaimRaw(vsId);
  return claim ? mapClaimToVS(claim) : null;
}

/** Returns VSDetailSnapshot with cache metadata. */
export async function getVSFull(
  vsId: number,
  opts?: { inviteKey?: string; viewerAddress?: string }
): Promise<VSDetailSnapshot> {
  if (typeof window !== "undefined") {
    const url = opts?.inviteKey
      ? `/api/vs/${vsId}?invite=${encodeURIComponent(opts.inviteKey)}`
      : `/api/vs/${vsId}`;
    const res = await fetch(url);
    if (!res.ok) return { item: null, cache: null };
    const data = await res.json();
    return { item: data.item ?? null, cache: data.cache ?? null };
  }
  const claim = await readClaimRaw(vsId);
  return { item: claim ? mapClaimToVS(claim) : null, cache: makeLiveFreshness() };
}

// ── Public write functions ────────────────────────────────────────────────────
export async function createClaim(
  wallet: WalletArg,
  params: CreateClaimParams
): Promise<ClaimWriteResult> {
  // Incident kill switch. Create and stake pause independently, so a pricing bug
  // can stop new markets without freezing settlement or withdrawals.
  const gate = checkWriteAllowed({ capability: "create_market" });
  if (!gate.allowed) throw new Error(gate.detail ?? "market creation is unavailable");

  if (isDemoMode()) {
    return sendDemoTx("create_claim", params as unknown as Record<string, unknown>);
  }

  const signer = requireSigner(wallet, "create this market");
  const client = marketWriter(signer);
  const { value, write } = await sendCall<bigint>(
    "create_claim",
    await client.create_claim({
      creator: signer.publicKey,
      params: buildCreateParams(params),
    }),
  );
  return { ...write, claimId: Number(value) };
}

/**
 * Mode-aware pre-flight for a challenge, run against FRESH chain state.
 *
 * The contract enforces the slot count, the duel equal-stake rule and fixed-odds
 * liquidity, but a revert is a poor way to learn that a rival filled the last
 * slot between render and submit. This re-reads the claim rather than trusting UI
 * state and throws with the guard's own message.
 */
export async function assertChallengeAllowed(
  claimId: number,
  stakeAmount: number,
): Promise<void> {
  const claim = await readClaimRaw(claimId);
  if (!claim) throw new Error(`Claim ${claimId} not found`);

  const mode = toCanonicalMode({
    marketType: claim.market_type,
    oddsMode: claim.odds_mode,
    maxChallengers: claim.max_challengers,
  });

  const result = guardChallenge({
    settlementMode: mode.settlementMode,
    creatorStake: claim.creator_stake,
    challengerStake: stakeAmount,
    existingChallengers: claim.challenger_count,
    maxChallengers: claim.max_challengers,
    challengerPayoutBps: claim.challenger_payout_bps,
    availableCreatorLiquidity: unitsToUsdc(
      availableCreatorLiquidityUnits({
        creatorStakeUnits: usdcToUnits(claim.creator_stake),
        reservedLiabilityUnits: usdcToUnits(claim.reserved_creator_liability),
      }),
    ),
  });

  if (!result.ok) throw new Error(result.message ?? "challenge not allowed");
}

export async function challengeClaim(
  wallet: WalletArg,
  claimId: number,
  stakeAmount: number,
  inviteKey = ""
): Promise<ClaimWriteResult> {
  // Before the demo branch, as in createClaim: the demo relay signs with a funded
  // server key, so a stake pause that only covered the non-demo path was bypassed.
  const stakeGate = checkWriteAllowed({ capability: "stake" });
  if (!stakeGate.allowed) throw new Error(stakeGate.detail ?? "staking is unavailable");
  if (isDemoMode()) {
    return sendDemoTx("challenge_claim", { claimId, stakeAmount, inviteKey });
  }
  await assertChallengeAllowed(claimId, stakeAmount);

  const signer = requireSigner(wallet, "join this market");
  const client = marketWriter(signer);
  const { write } = await sendCall<void>(
    "challenge_claim",
    await client.challenge_claim({
      challenger: signer.publicKey,
      claim_id: BigInt(claimId),
      stake_amount: usdcToUnits(stakeAmount),
      invite_key: inviteKey || undefined,
    }),
  );
  return { ...write, claimId };
}

/**
 * Record the oracle's verdict.
 *
 * Oracle-only: the contract checks `require_auth` against the stored oracle
 * address. Without a verdict this keeps the old browser behaviour and refuses,
 * because a resolution with no winner side is `InvalidVerdict` on chain anyway.
 */
export async function resolveClaim(
  wallet: WalletArg,
  claimId: number,
  verdict?: {
    winner_side: Exclude<ClaimData["winner_side"], "">;
    summary: string;
    confidence: number;
    evidence_hash?: string;
  },
): Promise<ClaimWriteResult> {
  // Pausing settlement only delays it: withdraw and payout claims stay ungated, and
  // an expired claim is simply settled on the first poll after the switch clears.
  const gate = checkWriteAllowed({ capability: "oracle_settlement" });
  if (!gate.allowed) throw new Error(gate.detail ?? "settlement is unavailable");
  if (isDemoMode()) {
    return sendDemoTx("resolve_claim", { claimId });
  }
  if (!verdict) {
    throw new Error(
      "Claims are resolved by the Mimir oracle agent. Connect as oracle to resolve manually.",
    );
  }

  const signer = requireSigner(wallet, "resolve this market");
  const client = marketWriter(signer);
  const { write } = await sendCall<void>(
    "resolve_claim",
    await client.resolve_claim({
      claim_id: BigInt(claimId),
      winner_side: toWinnerSide(verdict.winner_side),
      summary: verdict.summary,
      confidence: verdict.confidence,
      evidence_hash: fromHex32(verdict.evidence_hash, "evidence_hash"),
    }),
  );
  return { ...write, claimId };
}

export async function cancelClaim(
  wallet: WalletArg,
  claimId: number
): Promise<ClaimWriteResult> {
  if (isDemoMode()) {
    return sendDemoTx("cancel_claim", { claimId });
  }
  const signer = requireSigner(wallet, "cancel this market");
  const { write } = await sendCall<void>(
    "cancel_claim",
    await marketWriter(signer).cancel_claim({ claim_id: BigInt(claimId) }),
  );
  return { ...write, claimId };
}

/**
 * Open a rematch of `parentId`.
 *
 * DEVIATION: the EVM contract had a dedicated `createRematch` that copied the
 * parent's terms on chain. The Soroban contract does not — `parent_id` is just a
 * field on `CreateParams` — so the copy happens here, from a fresh read of the
 * parent. Same call signature, one extra read.
 */
export async function createRematch(
  wallet: WalletArg,
  parentId: number,
  params: Pick<CreateClaimParams, "deadline" | "stake_amount" | "invite_key">
): Promise<ClaimWriteResult> {
  // The non-demo path reaches createClaim's gate; the demo relay does not.
  const gate = checkWriteAllowed({ capability: "create_market" });
  if (!gate.allowed) throw new Error(gate.detail ?? "market creation is unavailable");
  if (isDemoMode()) {
    return sendDemoTx("create_rematch", { parentId, ...params });
  }
  const parent = await readClaimRaw(parentId);
  if (!parent) throw new Error(`Claim ${parentId} not found`);

  return createClaim(wallet, {
    question:              parent.question,
    creator_position:      parent.creator_position,
    counter_position:      parent.counter_position,
    resolution_url:        parent.resolution_url,
    category:              parent.category,
    market_type:           parent.market_type,
    odds_mode:             parent.odds_mode,
    challenger_payout_bps: parent.challenger_payout_bps,
    handicap_line:         parent.handicap_line,
    settlement_rule:       parent.settlement_rule,
    max_challengers:       parent.max_challengers,
    visibility:            parent.visibility,
    parent_id:             parentId,
    deadline:              params.deadline,
    stake_amount:          params.stake_amount,
    invite_key:            params.invite_key ?? "",
  });
}

/**
 * Pull one challenger's settlement after resolution.
 *
 * NEW — no EVM counterpart. `resolve_claim` seeds `remaining_escrow` and each
 * challenger draws their share down with this call; the last claimant absorbs the
 * truncation dust. Callable once per challenger, and the caller must be the
 * challenger (the contract `require_auth`s them).
 */
export async function claimChallengerPayout(
  wallet: WalletArg,
  claimId: number,
): Promise<ClaimWriteResult & { netPayout: number }> {
  const signer = requireSigner(wallet, "collect this payout");
  const { value, write } = await sendCall<bigint>(
    "claim_challenger_payout",
    await marketWriter(signer).claim_challenger_payout({
      challenger: signer.publicKey,
      claim_id: BigInt(claimId),
    }),
  );
  return { ...write, claimId, netPayout: unitsToUsdc(value) };
}

/**
 * Sweep funds parked by a failed payout push.
 *
 * NEW as a first-class call: the EVM contract had `withdraw()` keyed on
 * `msg.sender`, which Soroban has no equivalent for, so the beneficiary is an
 * explicit argument that must authorize.
 */
export async function withdraw(
  wallet: WalletArg,
): Promise<ContractWriteResult & { amount: number }> {
  const signer = requireSigner(wallet, "withdraw");
  const { value, write } = await sendCall<bigint>(
    "withdraw",
    await marketWriter(signer).withdraw({ who: signer.publicKey }),
  );
  return { ...write, amount: unitsToUsdc(value) };
}

/** Claim accrued platform / agent-owner fees. Pull, never pushed. */
export async function claimFees(
  wallet: WalletArg,
): Promise<ContractWriteResult & { amount: number }> {
  const signer = requireSigner(wallet, "claim fees");
  const { value, write } = await sendCall<bigint>(
    "claim_fees",
    await marketWriter(signer).claim_fees({ who: signer.publicKey }),
  );
  return { ...write, amount: unitsToUsdc(value) };
}

// ── Squad pool (mimir-squad) ──────────────────────────────────────────────────
export const SQUAD_CONTRACT_ADDRESS = getSquadContractId();

/** Side ids as the squad contract numbers them. */
export const SQUAD_SIDE = { A: 1, B: 2 } as const;
export const SQUAD_RESULT_CANCELLED = 3;

export interface SquadMarketData {
  id: number;
  captain: string;
  deadline: number;
  fee_bps: number;
  pool_a: number;
  pool_b: number;
  participants_a: number;
  participants_b: number;
  resolved: boolean;
  /** 0 until resolved, then SQUAD_SIDE.A / .B / SQUAD_RESULT_CANCELLED. */
  result: number;
  remaining_escrow: number;
  winner_claims: number;
}

function decodeSquadMarket(id: number, market: MimirSquad.Market): SquadMarketData {
  return {
    id,
    captain:          market.captain,
    deadline:         Number(market.deadline),
    fee_bps:          Number(market.fee_bps),
    pool_a:           unitsToUsdc(market.pool_a),
    pool_b:           unitsToUsdc(market.pool_b),
    participants_a:   Number(market.participants_a),
    participants_b:   Number(market.participants_b),
    resolved:         market.resolved,
    result:           Number(market.result),
    remaining_escrow: unitsToUsdc(market.remaining_escrow),
    winner_claims:    Number(market.winner_claims),
  };
}

export async function getSquadMarketCount(): Promise<number> {
  const tx = await squadReader().get_market_count();
  return Number(tx.result ?? 0n);
}

export async function getSquadMarket(marketId: number): Promise<SquadMarketData | null> {
  const tx = await squadReader().get_market({ market_id: BigInt(marketId) });
  const market = unwrapOrNull<MimirSquad.Market>(tx.result);
  return market ? decodeSquadMarket(marketId, market) : null;
}

export async function getSquadDeposit(
  marketId: number,
  side: number,
  who: string,
): Promise<number> {
  const tx = await squadReader().get_deposit({
    market_id: BigInt(marketId),
    side,
    who,
  });
  return unitsToUsdc(tx.result ?? 0n);
}

export async function hasSquadClaimed(
  marketId: number,
  side: number,
  who: string,
): Promise<boolean> {
  const tx = await squadReader().has_claimed({ market_id: BigInt(marketId), side, who });
  return Boolean(tx.result);
}

export async function previewSquadClaim(
  marketId: number,
  side: number,
  who: string,
): Promise<{ gross: number; fee: number; net: number } | null> {
  const tx = await squadReader().preview_claim({ market_id: BigInt(marketId), side, who });
  const preview = unwrapOrNull<MimirSquad.ClaimResult>(tx.result);
  if (!preview) return null;
  return {
    gross: unitsToUsdc(preview.gross),
    fee:   unitsToUsdc(preview.fee),
    net:   unitsToUsdc(preview.net),
  };
}

export async function createSquadMarket(
  wallet: WalletArg,
  params: { question: string; deadline: number; fee_bps: number },
): Promise<ContractWriteResult & { marketId: number }> {
  // Squad pools move USDC like binary markets do, so the same switches stop them.
  const gate = checkWriteAllowed({ capability: "create_market" });
  if (!gate.allowed) throw new Error(gate.detail ?? "market creation is unavailable");
  const signer = requireSigner(wallet, "open this squad market");
  const { value, write } = await sendCall<bigint>(
    "create_market",
    await squadWriter(signer).create_market({
      captain: signer.publicKey,
      question: params.question,
      deadline: BigInt(params.deadline),
      fee_bps: params.fee_bps,
    }),
  );
  return { ...write, marketId: Number(value) };
}

export async function squadDeposit(
  wallet: WalletArg,
  marketId: number,
  side: number,
  amount: number,
): Promise<ContractWriteResult> {
  const gate = checkWriteAllowed({ capability: "stake" });
  if (!gate.allowed) throw new Error(gate.detail ?? "staking is unavailable");
  const signer = requireSigner(wallet, "back this side");
  const { write } = await sendCall<void>(
    "deposit",
    await squadWriter(signer).deposit({
      participant: signer.publicKey,
      market_id: BigInt(marketId),
      side,
      amount: usdcToUnits(amount),
    }),
  );
  return write;
}

/** Pull a squad-pool payout. Pull-based for the same footprint reason as above. */
export async function squadClaim(
  wallet: WalletArg,
  marketId: number,
  side: number,
): Promise<ContractWriteResult & { netPayout: number }> {
  const signer = requireSigner(wallet, "collect this payout");
  const { value, write } = await sendCall<bigint>(
    "claim",
    await squadWriter(signer).claim({
      participant: signer.publicKey,
      market_id: BigInt(marketId),
      side,
    }),
  );
  return { ...write, netPayout: unitsToUsdc(value) };
}

export async function squadWithdrawBeforeDeadline(
  wallet: WalletArg,
  marketId: number,
  side: number,
  amount: number,
): Promise<ContractWriteResult> {
  const signer = requireSigner(wallet, "withdraw this stake");
  const { write } = await sendCall<void>(
    "withdraw_before_deadline",
    await squadWriter(signer).withdraw_before_deadline({
      participant: signer.publicKey,
      market_id: BigInt(marketId),
      side,
      amount: usdcToUnits(amount),
    }),
  );
  return write;
}

// ── Write: demo relay (via server API) ───────────────────────────────────────
async function sendDemoTx(
  action: string,
  params: Record<string, unknown>
): Promise<ContractWriteResult & { claimId: number | null }> {
  const res = await fetch("/api/demo/write", {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ action, params }),
  });
  if (!res.ok) throw new Error(`Demo relay error: ${res.status}`);
  const data = await res.json();
  return {
    txHash:      data.txHash ?? "",
    explorerUrl: data.txHash ? getExplorerTxUrl(data.txHash) : undefined,
    receipt:     null,
    pending:     data.pending ?? false,
    claimId:     data.claimId ?? null,
  };
}

// ── Server-side demo write ────────────────────────────────────────────────────
/**
 * Server-signed writes for the demo relay.
 *
 * The demo keys are Stellar secrets (`S…`), read from `DEMO_*_STELLAR_SECRET`
 * with a fallback to the older `DEMO_*_PRIVATE_KEY` names so an existing
 * deployment's env layout keeps working. `basicNodeSigner` is used rather than a
 * bare `signTransaction`, because it also provides `signAuthEntry`, which the
 * USDC transfer inside `create_claim`/`challenge_claim` requires.
 */
export async function executeDemoWrite(
  action: string,
  params: Record<string, unknown>
): Promise<ClaimWriteResult> {
  const signer = await getDemoSigner(action);
  if (!signer) throw new Error(`No demo key configured for action: ${action}`);

  if (action === "create_claim") {
    return createClaim(signer, params as unknown as CreateClaimParams);
  }

  if (action === "challenge_claim") {
    const { claimId, stakeAmount, inviteKey = "" } = params as {
      claimId: number | string;
      stakeAmount: number | string;
      inviteKey?: string;
    };
    // Same guard on the server signer path — a relay must not be able to bypass
    // the mode rules a browser caller is held to.
    await assertChallengeAllowed(Number(claimId), Number(stakeAmount));
    return challengeClaim(signer, Number(claimId), Number(stakeAmount), inviteKey);
  }

  if (action === "resolve_claim") {
    const { claimId } = params as { claimId: number | string };
    throw new Error(`Claim ${claimId}: use the oracle agent to resolve.`);
  }

  if (action === "cancel_claim") {
    const { claimId } = params as { claimId: number | string };
    return cancelClaim(signer, Number(claimId));
  }

  if (action === "create_rematch") {
    const { parentId, deadline, stake_amount, invite_key = "" } = params as {
      parentId: number | string;
      deadline: number;
      stake_amount: number;
      invite_key?: string;
    };
    return createRematch(signer, Number(parentId), {
      deadline,
      stake_amount,
      invite_key,
    });
  }

  throw new Error(`Unknown demo action: ${action}`);
}

// ── Helper: build the CreateParams struct ─────────────────────────────────────
function buildCreateParams(p: CreateClaimParams): MimirMarket.CreateParams {
  return {
    question:              p.question,
    creator_position:      p.creator_position,
    counter_position:      p.counter_position,
    resolution_url:        p.resolution_url,
    deadline:              BigInt(p.deadline),
    stake_amount:          usdcToUnits(p.stake_amount),
    category:              p.category ?? "custom",
    parent_id:             BigInt(p.parent_id ?? 0),
    market_type:           p.market_type ?? "binary",
    odds_mode:             p.odds_mode ?? "pool",
    challenger_payout_bps: p.challenger_payout_bps ?? 0,
    handicap_line:         p.handicap_line ?? "",
    settlement_rule:       p.settlement_rule ?? "",
    max_challengers:       p.max_challengers ?? 0,
    is_private:            p.visibility === "private",
    // `Option<String>`: an empty invite key is `None`, not `Some("")`. Passing an
    // empty string would hash to a real key hash and lock the market to it.
    invite_key:            p.invite_key ? p.invite_key : undefined,
    context_hash:          fromHex32(p.context_hash, "context_hash"),
    agent_owner_recipient: p.agent_owner_recipient ?? undefined,
  };
}

// ── Demo mode helpers ─────────────────────────────────────────────────────────
function isDemoMode(): boolean {
  return process.env.NEXT_PUBLIC_DEMO_MODE === "1";
}

function getDemoSecret(action: string): string | undefined {
  if (action === "create_claim" || action === "create_rematch") {
    return (
      process.env.DEMO_CREATOR_STELLAR_SECRET ||
      process.env.DEMO_SIGNER_STELLAR_SECRET ||
      process.env.DEMO_CREATOR_PRIVATE_KEY ||
      process.env.DEMO_SIGNER_PRIVATE_KEY
    );
  }
  if (action === "challenge_claim") {
    return (
      process.env.DEMO_CHALLENGER_STELLAR_SECRET ||
      process.env.DEMO_SIGNER_STELLAR_SECRET ||
      process.env.DEMO_CHALLENGER_PRIVATE_KEY ||
      process.env.DEMO_SIGNER_PRIVATE_KEY
    );
  }
  return process.env.DEMO_SIGNER_STELLAR_SECRET || process.env.DEMO_SIGNER_PRIVATE_KEY;
}

async function getDemoSigner(action: string): Promise<StellarSigner | null> {
  const secret = getDemoSecret(action)?.trim();
  if (!secret) return null;
  const { Keypair } = await import("@stellar/stellar-sdk");
  const { basicNodeSigner } = await import("@stellar/stellar-sdk/contract");
  const { NETWORK_PASSPHRASE } = await import("./stellar");
  const keypair = Keypair.fromSecret(secret);
  const signer = basicNodeSigner(keypair, NETWORK_PASSPHRASE);
  return {
    publicKey: keypair.publicKey(),
    signTransaction: signer.signTransaction,
    signAuthEntry: signer.signAuthEntry,
  };
}

// ── Freshness helper ──────────────────────────────────────────────────────────
function makeLiveFreshness(): VSCacheFreshness {
  return {
    source:           "contract",
    status:           "live",
    lastUpdatedAt:    new Date().toISOString(),
    ageMs:            0,
    freshnessWindowMs: 1,
  };
}

// ── VS data helpers ───────────────────────────────────────────────────────────
/**
 * Address equality.
 *
 * Stellar StrKeys are case-SENSITIVE base32 — `toLowerCase()` would corrupt them
 * — so this is an exact comparison after trimming, not the EVM `toLowerCase()`
 * pair it replaces.
 */
function isSameAddress(a?: string, b?: string) {
  return !!a && !!b && a.trim() === b.trim();
}

function isClaimParticipant(claim: ClaimData, address: string): boolean {
  if (isSameAddress(claim.creator, address)) return true;
  return (claim.challenger_addresses ?? []).some((a) => isSameAddress(a, address));
}

export function mapClaimToVS(claim: ClaimData): VSData {
  const firstChallenger = claim.first_challenger ?? ZERO_ADDRESS;
  const state = claim.state === "active" ? "accepted" : (claim.state as VSData["state"]);

  let winner = ZERO_ADDRESS;
  if (claim.winner_side === "creator") winner = claim.creator;
  else if (claim.winner_side === "challengers") {
    winner = claim.challenger_addresses?.[0] ?? firstChallenger;
  }

  return {
    ...claim,
    opponent:          firstChallenger,
    opponent_position: claim.counter_position,
    stake_amount:      claim.creator_stake,
    state,
    winner,
  };
}

export function isVSPrivate(vs: Pick<VSData, "is_private" | "visibility">) {
  return Boolean(vs.is_private || vs.visibility === "private");
}

export function getVSConfiguredMaxChallengers(vs: VSData) {
  return typeof vs.max_challengers === "number" && vs.max_challengers > 0
    ? vs.max_challengers
    : 1;
}

export function getVSChallengerCount(vs: VSData) {
  if (typeof vs.challenger_count === "number" && vs.challenger_count >= 0) {
    return vs.challenger_count;
  }
  return vs.opponent !== ZERO_ADDRESS ? 1 : 0;
}

export function hasZeroAddressWinner(vs: VSData) {
  return !vs.winner || vs.winner === ZERO_ADDRESS;
}

export function isVSMultiChallengerWin(vs: VSData) {
  return vs.winner_side === "challengers" && getVSChallengerCount(vs) !== 1;
}

export function getVSTotalPot(vs: VSData) {
  if (typeof vs.total_pot === "number" && Number.isFinite(vs.total_pot)) return vs.total_pot;
  if (typeof vs.creator_stake === "number" && typeof vs.total_challenger_stake === "number") {
    return vs.creator_stake + vs.total_challenger_stake;
  }
  return vs.stake_amount * (vs.opponent === ZERO_ADDRESS ? 1 : 2);
}

export function getVSSingleWinnerPayout(vs: VSData): number | null {
  if (!hasVSWinner(vs)) return 0;

  if (vs.winner_side === "creator" || isSameAddress(vs.winner, vs.creator)) {
    return getVSTotalPot(vs);
  }

  if (vs.winner_side === "challengers") {
    if (getVSChallengerCount(vs) !== 1) return null;
    const stake = vs.total_challenger_stake ?? vs.stake_amount;
    if (vs.odds_mode === "fixed" && (vs.challenger_payout_bps ?? 0) > 0) {
      return Math.floor((stake * vs.challenger_payout_bps!) / BPS_DIVISOR);
    }
    return getVSTotalPot(vs);
  }

  return getVSTotalPot(vs);
}

export function hasVSWinner(vs: VSData) {
  return (
    vs.winner_side === "creator" ||
    vs.winner_side === "challengers" ||
    vs.winner !== ZERO_ADDRESS
  );
}

export function isVSJoinable(vs: VSData, address?: string | null) {
  if (vs.state !== "open" && vs.state !== "accepted") return false;
  if (address) {
    if (isSameAddress(vs.creator, address) || didUserChallengeVS(vs, address)) return false;
  }
  if (getVSChallengerCount(vs) >= getVSConfiguredMaxChallengers(vs)) return false;
  const nowSec = Math.floor(Date.now() / 1000);
  if (vs.deadline > 0 && nowSec + VS_CHALLENGE_LOCK_SECONDS > vs.deadline) return false;
  return true;
}

export function didUserChallengeVS(vs: VSData, address?: string | null) {
  if (!address) return false;
  if ((vs.challenger_addresses ?? []).some((a) => isSameAddress(a, address))) return true;
  return vs.opponent !== ZERO_ADDRESS && isSameAddress(vs.opponent, address);
}

export function didUserWinVS(vs: VSData, address?: string | null) {
  if (!address || !hasVSWinner(vs)) return false;
  if (vs.winner_side === "creator") return isSameAddress(vs.creator, address);
  if (vs.winner_side === "challengers") return didUserChallengeVS(vs, address);
  return isSameAddress(vs.winner, address);
}

export function didUserLoseVS(vs: VSData, address?: string | null) {
  if (!address || !hasVSWinner(vs)) return false;
  const involved = isSameAddress(vs.creator, address) || didUserChallengeVS(vs, address);
  return involved && !didUserWinVS(vs, address);
}

function getVSUserChallenger(vs: VSData, address?: string | null) {
  if (!address) return null;
  return (vs.challengers ?? []).find((challenger) =>
    isSameAddress(challenger.address, address)
  ) ?? null;
}

function getVSUserChallengerStake(vs: VSData, address?: string | null): number {
  const challenger = getVSUserChallenger(vs, address);
  if (challenger && Number.isFinite(challenger.stake)) return challenger.stake;
  const n = Math.max(1, getVSChallengerCount(vs));
  if ((vs.total_challenger_stake ?? 0) > 0) {
    return n <= 1 ? vs.total_challenger_stake! : vs.total_challenger_stake! / n;
  }
  return vs.stake_amount ?? 0;
}

export function getVSUserCommittedStake(vs: VSData, address?: string | null): number {
  if (!address) return 0;
  if (isSameAddress(vs.creator, address)) {
    return vs.creator_stake ?? vs.stake_amount ?? 0;
  }
  if (!didUserChallengeVS(vs, address)) return 0;
  return getVSUserChallengerStake(vs, address);
}

export function getVSUserWinAmount(vs: VSData, address?: string | null) {
  if (!didUserWinVS(vs, address)) return 0;
  if (vs.winner_side === "creator") return getVSTotalPot(vs);
  if (vs.winner_side === "challengers") {
    const challenger = getVSUserChallenger(vs, address);
    if (challenger && Number.isFinite(challenger.potential_payout)) {
      return challenger.potential_payout;
    }

    const stake = getVSUserChallengerStake(vs, address);
    if (vs.odds_mode === "fixed" && (vs.challenger_payout_bps ?? 0) > 0) {
      return (stake * vs.challenger_payout_bps!) / BPS_DIVISOR;
    }

    const totalChallengerStake = vs.total_challenger_stake ?? stake;
    const creatorStake = vs.creator_stake ?? vs.stake_amount ?? 0;
    if (totalChallengerStake <= 0) return stake;
    return stake + (stake * creatorStake) / totalChallengerStake;
  }
  return getVSTotalPot(vs);
}

// ── Legacy aliases (backwards compat with VS detail/create pages) ─────────────

/** Alias for challengeClaim — kept for page compatibility */
export async function acceptVS(
  wallet: WalletArg,
  claimId: number,
  stakeAmount: number,
  inviteKey = ""
): Promise<ClaimWriteResult> {
  return challengeClaim(wallet, claimId, stakeAmount, inviteKey);
}

// ── Server-layer aliases (used by lib/server/vs-cache.ts + vs-index.ts) ──────

/** Returns open/active public claims as VSData[]. */
export async function getOpenVSSummaries(): Promise<VSData[]> {
  return (await getOpenClaimSummaries()).map(mapClaimToVS);
}

/** Returns paginated claims as ClaimData (for server-side indexer). */
export async function getClaimSummaries(startId: number, limit: number): Promise<ClaimData[]> {
  const results = await readClaimsRange(startId, limit);
  return results.filter(Boolean) as ClaimData[];
}

/** Returns a single claim, optionally checking invite key. */
export async function getClaimWithAccess(
  claimId: number,
  _inviteKey?: string
): Promise<ClaimData | null> {
  return readClaimRaw(claimId);
}

/** Returns open/active public claims as ClaimData. */
export async function getOpenClaimSummaries(): Promise<ClaimData[]> {
  const count = await getClaimCount();
  if (count <= 0) return [];
  const all = await readClaimsRange(1, count);
  return (all.filter(Boolean) as ClaimData[]).filter(
    (c) => (c.state === "open" || c.state === "active") && !c.is_private
  );
}

/** Returns claims for a user as ClaimData. */
export async function getUserClaimSummaries(address: string): Promise<ClaimData[]> {
  const count = await getClaimCount();
  if (count <= 0) return [];
  const all = await readClaimsRange(1, count);
  return (all.filter(Boolean) as ClaimData[]).filter((c) => isClaimParticipant(c, address));
}

/** @deprecated use getAllVSFast */
export async function getAllVSSnapshot(
  opts?: { forceRefresh?: boolean }
): Promise<VSFeedSnapshot> {
  // In the browser this MUST go through /api/vs (the indexed cache): simulating
  // two invocations per claim against the public Soroban RPC trips its
  // per-client rate limit and the whole feed comes back empty.
  if (typeof window !== "undefined") {
    const res = await fetch(opts?.forceRefresh ? "/api/vs?refresh=1" : "/api/vs");
    if (!res.ok) throw new Error(`/api/vs returned ${res.status}`);
    const data = await res.json();
    return { items: data.items ?? [], cache: data.cache ?? null };
  }
  return getAllVSDirect();
}

/** @deprecated use getUserVSFast */
export async function getUserVSSnapshot(
  address: string,
  opts?: { forceRefresh?: boolean }
): Promise<VSFeedSnapshot> {
  if (typeof window !== "undefined") {
    const suffix = opts?.forceRefresh ? "?refresh=1" : "";
    const res = await fetch(`/api/vs/user/${address}${suffix}`);
    if (!res.ok) throw new Error(`/api/vs/user returned ${res.status}`);
    const data = await res.json();
    return { items: data.items ?? [], cache: data.cache ?? null };
  }
  const items = await getUserVSSummaries(address);
  return { items: items.sort((a, b) => b.id - a.id), cache: makeLiveFreshness() };
}

/** Alias for cancelClaim — kept for page compatibility */
export async function cancelVS(
  wallet: WalletArg,
  claimId: number,
  _inviteKey = ""
): Promise<ClaimWriteResult> {
  return cancelClaim(wallet, claimId);
}

/** Alias for getUserVSSummaries — kept for page compatibility */
export async function getUserVSDirect(address: string): Promise<VSData[]> {
  return getUserVSSummaries(address);
}

/**
 * Traverse parent_id chain to build a rivalry chain.
 * Returns an array of claim IDs from root → all descendants (BFS).
 */
export async function getRivalryChain(claimId: number): Promise<number[]> {
  const visited = new Set<number>();
  const queue   = [claimId];
  const result: number[] = [];

  while (queue.length > 0) {
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    result.push(id);

    const claim = await readClaimRaw(id);
    if (!claim) continue;

    // Walk up to root
    if (claim.parent_id > 0 && !visited.has(claim.parent_id)) {
      queue.unshift(claim.parent_id);
    }
  }

  return result;
}

/**
 * Resolution is handled by the off-chain oracle agent automatically.
 * This stub is kept for UI compatibility — it no longer sends a transaction.
 */
export async function requestResolveVS(
  _wallet: WalletArg,
  _claimId: number,
  _inviteKey = ""
): Promise<ClaimWriteResult> {
  throw new Error(
    "Resolution is handled automatically by the Mimir oracle agent after the deadline. No user action required."
  );
}

/** Kept for UI compatibility — no-op. */
export async function resetVSResolveRequest(
  _wallet: WalletArg,
  _claimId: number,
  _inviteKey = ""
): Promise<ClaimWriteResult> {
  throw new Error("Not applicable — the oracle resolves automatically.");
}

/** Re-exported so callers can watch a write without importing lib/stellar too. */
export { waitForTransaction } from "./stellar";

/** Escape hatch for one-off reads the typed helpers do not cover. */
export function getMarketClient(signer?: StellarSigner): MimirMarket.Client {
  return signer ? marketWriter(signer) : marketReader();
}

export function getSquadClient(signer?: StellarSigner): MimirSquad.Client {
  return signer ? squadWriter(signer) : squadReader();
}

/** The Soroban RPC server the contract clients talk to. */
export { createSorobanRpcServer };
