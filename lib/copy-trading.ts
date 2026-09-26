/**
 * Copy trading policy and deterministic execution gate.
 *
 * Every USDC figure that crosses a boundary here is atomic at **7 decimals**
 * (`lib/usdc.ts`), not the 6 the EVM-era ERC-20 used. `maxRealizedLossAtomic` and
 * `realizedLossAtomic` are the two fields where that matters, because they are the
 * only ones supplied as atomic strings rather than derived from a display number
 * through `parseUsdcAtomic` — a 6-decimal value there reads as a tenth of the
 * intended limit and stops copying ten times too early.
 */

import { sha256Hex } from "@/lib/content-hash";
import { isPaused } from "@/lib/ops/flags";
import { isAccountAddress, isContractAddress } from "@/lib/stellar";
import { parseUsdcAtomic } from "@/lib/usdc";

/** A wallet or contract id. Case-sensitive base32: never fold it. */
function isStellarAddress(value: string): boolean {
  const trimmed = value?.trim() ?? "";
  return isAccountAddress(trimmed) || isContractAddress(trimmed);
}

export interface CopyPermission {
  permissionId: string;
  ownerWallet: string;
  executionAgentId: string;
  signalAgentId: string;
  maxPerPositionUsdc: number;
  dailyCapUsdc: number;
  weeklyCapUsdc: number;
  totalOpenExposureUsdc: number;
  /**
   * Maximum realized loss plus the full principal at risk of the next copy.
   * Atomic USDC at 7 decimals — 15 USDC is `"150000000"`.
   */
  maxRealizedLossAtomic: string;
  allowedCategories: string[];
  allowedModes: string[];
  minConfidenceBps: number;
  minPayoutBps: number;
  expiresAt: number;
  depth: 1;
  status: "active" | "revoked" | "paused";
  spendPermission: { token: string; spender: string; allowanceAtomic: bigint; periodSeconds: number };
  signedPolicyHash: string;
}

export interface CopyUsage {
  usedTodayUsdc: number;
  usedThisWeekUsdc: number;
  openExposureUsdc: number;
  /** Atomic USDC at 7 decimals. */
  realizedLossAtomic: string;
}

export interface CopySignal {
  sourcePositionId: string;
  signalAgentId: string;
  sourceDepth: number;
  claimId: number;
  category: string;
  mode: string;
  confidenceBps: number;
  payoutBps: number;
  stakeUsdc: number;
  deadline: number;
  remainingSlots: number;
  availableLiquidityUsdc: number;
  requiredLiquidityUsdc: number;
  sourceAttributionId: string;
  /** Optional chain status for callers that have already fetched the live claim. */
  marketState?: "open" | "active" | "resolved" | "cancelled";
}

export type CopySkipReason =
  | "global_paused" | "permission_revoked" | "permission_paused" | "permission_expired"
  | "malformed_signal" | "malformed_context" | "signal_agent_mismatch"
  | "self_copy" | "copy_depth" | "cycle" | "duplicate_position" | "stale_signal"
  | "market_cancelled" | "market_closed" | "market_full" | "liquidity_exhausted"
  | "category_blocked" | "mode_blocked"
  | "confidence_below_floor" | "payout_below_floor" | "position_cap"
  | "daily_cap" | "weekly_cap" | "open_exposure_cap" | "spend_permission_mismatch"
  | "loss_limit" | "simulation_failed";

export interface CopyExecutionContext {
  now: number;
  /** Caller-side stop. MIMIR_PAUSE_COPY_EXECUTION is checked regardless of this. */
  globalPaused: boolean;
  /** Env the incident switch is read from; defaults to process.env. */
  env?: Record<string, string | undefined>;
  usage: CopyUsage;
  existingClaimIds: ReadonlySet<number>;
  ancestryAgentIds: readonly string[];
  configuredUsdc: string;
  configuredSpender: string;
  onchainAllowanceAtomic: bigint;
  /**
   * Outcome of simulating the stake before signing it. `blockNumber` keeps its
   * name because `lib/db.ts` persists it under that column; on Stellar the value
   * is the LEDGER SEQUENCE the simulation was run against.
   */
  simulation: { ok: boolean; blockNumber: bigint; reason?: string };
}

export function copyPolicyHash(input: Omit<CopyPermission, "signedPolicyHash">): string {
  return sha256Hex(JSON.stringify(input, (_, value) => typeof value === "bigint" ? value.toString() : value));
}

function parseAtomicString(value: string): bigint {
  if (!/^(0|[1-9]\d*)$/.test(value)) throw new Error("invalid atomic amount");
  return BigInt(value);
}

/** Validate the externally supplied, owner-signed policy before storing it. */
export function validateCopyPermission(input: Omit<CopyPermission, "signedPolicyHash">, now = Date.now()): string | null {
  if (!input.permissionId.trim() || input.permissionId.length > 128) return "invalid_permission_id";
  if (!isStellarAddress(input.ownerWallet) || !isStellarAddress(input.spendPermission.token) || !isStellarAddress(input.spendPermission.spender)) return "invalid_address";
  if (!input.executionAgentId.trim() || !input.signalAgentId.trim() || input.executionAgentId === input.signalAgentId) return "invalid_agent_pair";
  try {
    const position = parseUsdcAtomic(input.maxPerPositionUsdc);
    const daily = parseUsdcAtomic(input.dailyCapUsdc);
    const weekly = parseUsdcAtomic(input.weeklyCapUsdc);
    const exposure = parseUsdcAtomic(input.totalOpenExposureUsdc);
    const loss = parseAtomicString(input.maxRealizedLossAtomic);
    if (position <= 0n || daily < position || weekly < daily || exposure < position || loss <= 0n) return "invalid_budget";
  } catch { return "invalid_budget"; }
  if (input.spendPermission.allowanceAtomic <= 0n || !Number.isSafeInteger(input.spendPermission.periodSeconds) || input.spendPermission.periodSeconds <= 0) return "invalid_spend_permission";
  if (input.depth !== 1 || input.status !== "active" || !Number.isSafeInteger(input.expiresAt) || input.expiresAt <= now) return "invalid_lifecycle";
  if (!Number.isInteger(input.minConfidenceBps) || input.minConfidenceBps < 0 || input.minConfidenceBps > 10_000 ||
      !Number.isInteger(input.minPayoutBps) || input.minPayoutBps < 0) return "invalid_threshold";
  if (!Array.isArray(input.allowedCategories) || !Array.isArray(input.allowedModes) ||
      input.allowedCategories.length > 100 || input.allowedModes.length > 10) return "invalid_allowlist";
  return null;
}

export function worstCaseCopySpend(permission: CopyPermission): { perPositionUsdc: number; dailyUsdc: number; weeklyUsdc: number; totalOpenUsdc: number } {
  return { perPositionUsdc: permission.maxPerPositionUsdc, dailyUsdc: permission.dailyCapUsdc,
    weeklyUsdc: permission.weeklyCapUsdc, totalOpenUsdc: permission.totalOpenExposureUsdc };
}

export function evaluateCopy(permission: CopyPermission, signal: CopySignal, context: CopyExecutionContext):
  { allowed: true; stakeUsdc: number } | { allowed: false; reason: CopySkipReason } {
  // The switch is read here, not left to the caller: an executor that forgot to
  // map it into `globalPaused` would otherwise keep copying through an incident.
  if (context.globalPaused || isPaused("copy_execution", context.env)) return { allowed: false, reason: "global_paused" };
  if (permission.status === "revoked") return { allowed: false, reason: "permission_revoked" };
  if (permission.status === "paused") return { allowed: false, reason: "permission_paused" };
  if (!Number.isSafeInteger(context.now) || !context.usage ||
      typeof context.usage.usedTodayUsdc !== "number" ||
      typeof context.usage.usedThisWeekUsdc !== "number" ||
      typeof context.usage.openExposureUsdc !== "number" ||
      !Number.isSafeInteger(context.usage.usedTodayUsdc * 10_000_000) ||
      !Number.isSafeInteger(context.usage.usedThisWeekUsdc * 10_000_000) ||
      !Number.isSafeInteger(context.usage.openExposureUsdc * 10_000_000) ||
      typeof context.usage.realizedLossAtomic !== "string" ||
      !/^(0|[1-9]\d*)$/.test(context.usage.realizedLossAtomic) ||
      typeof context.onchainAllowanceAtomic !== "bigint" || context.onchainAllowanceAtomic < 0n ||
      typeof context.existingClaimIds?.has !== "function" || !Array.isArray(context.ancestryAgentIds) ||
      !context.ancestryAgentIds.every((id) => typeof id === "string") ||
      typeof context.configuredUsdc !== "string" || typeof context.configuredSpender !== "string" ||
      !context.simulation || typeof context.simulation.ok !== "boolean" ||
      typeof context.simulation.blockNumber !== "bigint" || context.simulation.blockNumber < 0n) {
    return { allowed: false, reason: "malformed_context" };
  }
  try {
    parseUsdcAtomic(context.usage.usedTodayUsdc);
    parseUsdcAtomic(context.usage.usedThisWeekUsdc);
    parseUsdcAtomic(context.usage.openExposureUsdc);
  } catch { return { allowed: false, reason: "malformed_context" }; }
  if (context.now >= permission.expiresAt) return { allowed: false, reason: "permission_expired" };
  if (typeof signal.sourcePositionId !== "string" || !signal.sourcePositionId || signal.sourcePositionId.length > 128 ||
      typeof signal.sourceAttributionId !== "string" || !signal.sourceAttributionId || signal.sourceAttributionId.length > 128 ||
      typeof signal.signalAgentId !== "string" || !signal.signalAgentId ||
      !Number.isSafeInteger(signal.claimId) || signal.claimId < 0 ||
      !Number.isSafeInteger(signal.sourceDepth) || signal.sourceDepth < 0 ||
      !Number.isSafeInteger(signal.deadline) ||
      !Number.isSafeInteger(signal.remainingSlots) ||
      !Number.isInteger(signal.confidenceBps) || signal.confidenceBps < 0 || signal.confidenceBps > 10_000 ||
      !Number.isInteger(signal.payoutBps) || signal.payoutBps < 0 ||
      typeof signal.category !== "string" || typeof signal.mode !== "string" ||
      !signal.category || !signal.mode ||
      !Number.isFinite(signal.stakeUsdc) || signal.stakeUsdc < 0 ||
      !Number.isFinite(signal.availableLiquidityUsdc) || signal.availableLiquidityUsdc < 0 ||
      !Number.isFinite(signal.requiredLiquidityUsdc) || signal.requiredLiquidityUsdc < 0 ||
      (signal.marketState !== undefined && !["open", "active", "resolved", "cancelled"].includes(signal.marketState))) {
    return { allowed: false, reason: "malformed_signal" };
  }
  try {
    parseUsdcAtomic(signal.stakeUsdc);
    parseUsdcAtomic(signal.availableLiquidityUsdc);
    parseUsdcAtomic(signal.requiredLiquidityUsdc);
  } catch { return { allowed: false, reason: "malformed_signal" }; }
  if (signal.signalAgentId === permission.executionAgentId) return { allowed: false, reason: "self_copy" };
  if (signal.signalAgentId !== permission.signalAgentId) return { allowed: false, reason: "signal_agent_mismatch" };
  if (signal.marketState === "cancelled") return { allowed: false, reason: "market_cancelled" };
  if (signal.marketState === "resolved") return { allowed: false, reason: "market_closed" };
  if (signal.sourceDepth >= permission.depth) return { allowed: false, reason: "copy_depth" };
  if (context.ancestryAgentIds.map((id) => id.toLowerCase()).includes(permission.executionAgentId.toLowerCase())) {
    return { allowed: false, reason: "cycle" };
  }
  if (context.existingClaimIds.has(signal.claimId)) return { allowed: false, reason: "duplicate_position" };
  if (signal.deadline <= context.now) return { allowed: false, reason: "stale_signal" };
  if (signal.remainingSlots <= 0) return { allowed: false, reason: "market_full" };
  if (parseUsdcAtomic(signal.requiredLiquidityUsdc) > parseUsdcAtomic(signal.availableLiquidityUsdc)) return { allowed: false, reason: "liquidity_exhausted" };
  if (permission.allowedCategories.length && !permission.allowedCategories.includes(signal.category)) return { allowed: false, reason: "category_blocked" };
  if (permission.allowedModes.length && !permission.allowedModes.includes(signal.mode)) return { allowed: false, reason: "mode_blocked" };
  if (signal.confidenceBps < permission.minConfidenceBps) return { allowed: false, reason: "confidence_below_floor" };
  if (signal.payoutBps < permission.minPayoutBps) return { allowed: false, reason: "payout_below_floor" };
  const stake = signal.stakeUsdc;
  const stakeAtomic = parseUsdcAtomic(stake);
  if (stakeAtomic <= 0n || stakeAtomic > parseUsdcAtomic(permission.maxPerPositionUsdc)) return { allowed: false, reason: "position_cap" };
  if (parseUsdcAtomic(context.usage.usedTodayUsdc) + stakeAtomic > parseUsdcAtomic(permission.dailyCapUsdc)) return { allowed: false, reason: "daily_cap" };
  if (parseUsdcAtomic(context.usage.usedThisWeekUsdc) + stakeAtomic > parseUsdcAtomic(permission.weeklyCapUsdc)) return { allowed: false, reason: "weekly_cap" };
  if (parseUsdcAtomic(context.usage.openExposureUsdc) + stakeAtomic > parseUsdcAtomic(permission.totalOpenExposureUsdc)) return { allowed: false, reason: "open_exposure_cap" };
  if (parseAtomicString(context.usage.realizedLossAtomic) + stakeAtomic > parseAtomicString(permission.maxRealizedLossAtomic)) return { allowed: false, reason: "loss_limit" };
  const spend = permission.spendPermission;
  const requiredAtomic = stakeAtomic;
  // Exact comparison: a Stellar contract id / account is case-sensitive base32,
  // so the EVM `toLowerCase()` pairing here would never match a real address.
  if (spend.token.trim() !== context.configuredUsdc.trim() ||
      spend.spender.trim() !== context.configuredSpender.trim() ||
      spend.allowanceAtomic < requiredAtomic || context.onchainAllowanceAtomic < requiredAtomic) {
    return { allowed: false, reason: "spend_permission_mismatch" };
  }
  if (!context.simulation.ok) return { allowed: false, reason: "simulation_failed" };
  return { allowed: true, stakeUsdc: stake };
}

export interface CopyAuditRecord {
  executionId: string;
  permissionId: string;
  sourcePositionId: string;
  signalAgentId: string;
  executionAgentId: string;
  sourceAttributionId: string;
  status: "executed" | "skipped" | "failed" | "expired";
  /** Atomic USDC at 7 decimals. */
  stakeAtomic: bigint;
  /** Ledger sequence the pre-flight simulation ran against. */
  simulationBlock: bigint;
  txHash?: string;
  platformFeeAtomic: bigint;
  ownerFeeAtomic: bigint;
  skipReason?: CopySkipReason;
  createdAt: number;
}
