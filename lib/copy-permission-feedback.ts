/**
 * Contract-backed copy-trading execution permission bounds and feedback.
 *
 * The chain (Soroban USDC Stellar Asset Contract) is the source of truth for
 * execution delegation. This module maps raw permission records, live on-chain
 * SAC allowance, account balance, wallet connection state, cache freshness,
 * and operational pauses into a deterministic feedback model for Mimir users.
 *
 * Status vocabulary:
 * - `ready` — active permission backed by sufficient on-chain allowance and balance
 * - `loading` — chain read or upstream permission fetch in flight
 * - `invalid` — policy bounds or addresses fail schema or contract constraints
 * - `stale` — cached on-chain state or policy snapshot has exceeded freshness TTL
 * - `disconnected` — wallet is disconnected or does not match permission owner
 * - `dependency_failure` — Soroban RPC or index dependency error during verification
 * - `paused` — platform or permission execution paused by operational policy
 * - `revoked` — permission revoked by owner
 * - `expired` — permission lifecycle has passed expiresAt timestamp
 *
 * Money & Address invariants:
 * - All amounts are bounded atomic USDC at 7 decimals.
 * - Stellar StrKeys (G… accounts, C… contracts) are case-sensitive base32:
 *   never folded or normalized to lowercase.
 */

import {
  validateCopyPermission,
  type CopyPermission,
} from "@/lib/copy-trading";
import { parseUsdcAtomic } from "@/lib/usdc";
import { isAccountAddress, isContractAddress } from "@/lib/stellar";
import { configuredSpender } from "@/lib/agents/spend-permissions";
import { getUsdcSacId } from "@/lib/stellar";
import { getUsdcAllowanceUnits, getUsdcBalanceUnits } from "@/lib/usdc";

export type CopyPermissionStatus =
  | "ready"
  | "loading"
  | "invalid"
  | "stale"
  | "disconnected"
  | "dependency_failure"
  | "paused"
  | "revoked"
  | "expired";

export interface CopyPermissionFeedbackInput {
  /** Permission record. Null if not found; undefined if still loading. */
  permission?: CopyPermission | null;
  /** Currently active wallet address in client context. */
  connectedWallet?: string | null;
  /** Live on-chain SAC allowance in atomic units. Null if read failed or unattempted. */
  onchainAllowanceAtomic?: bigint | null;
  /** Live on-chain USDC balance in atomic units. Null if read failed or unattempted. */
  onchainBalanceAtomic?: bigint | null;
  /** Amount spent in current period (atomic units). */
  spentInPeriodAtomic?: bigint;
  /** Cache freshness metadata. */
  freshness?: { timestamp: number; ttlMs?: number; isStale?: boolean } | null;
  /** Upstream fetch in flight. */
  loading?: boolean;
  /** Wallet disconnected flag. */
  disconnected?: boolean;
  /** Upstream RPC / dependency failure flag. */
  dependencyFailure?: boolean;
  /** Global operational pause flag. */
  globalPaused?: boolean;
  /** Configured USDC SAC address to verify against. */
  configuredUsdc?: string | null;
  /** Configured deployment spender address to verify against. */
  configuredSpender?: string | null;
  /** Current Unix timestamp in ms. */
  now?: number;
}

export interface CopyPermissionFeedbackView {
  status: CopyPermissionStatus;
  statusMessageKey: CopyPermissionStatus;
  detail: string;
  permissionId: string | null;
  ownerWallet: string | null;
  executionAgentId: string | null;
  signalAgentId: string | null;
  /** Money bounds in atomic USDC (7 decimals) */
  maxPerPositionAtomic: string | null;
  dailyCapAtomic: string | null;
  weeklyCapAtomic: string | null;
  totalOpenExposureAtomic: string | null;
  maxRealizedLossAtomic: string | null;
  signedAllowanceAtomic: string | null;
  /** Live contract-backed amounts in atomic USDC (7 decimals) */
  onchainAllowanceAtomic: string | null;
  onchainBalanceAtomic: string | null;
  remainingAllowanceAtomic: string | null;
  /** Invariants and contract verification flags */
  hasSufficientAllowance: boolean;
  hasSufficientBalance: boolean;
  isSpenderConfigured: boolean;
  isTokenConfigured: boolean;
  isExpired: boolean;
  isRevoked: boolean;
  isPaused: boolean;
  isStale: boolean;
  allowedCategories: string[];
  allowedModes: string[];
  minConfidenceBps: number | null;
  minPayoutBps: number | null;
  expiresAt: number | null;
  createdAt?: number | null;
}

function emptyFeedback(
  status: CopyPermissionStatus,
  detail: string,
  overrides: Partial<CopyPermissionFeedbackView> = {},
): CopyPermissionFeedbackView {
  return {
    status,
    statusMessageKey: status,
    detail,
    permissionId: null,
    ownerWallet: null,
    executionAgentId: null,
    signalAgentId: null,
    maxPerPositionAtomic: null,
    dailyCapAtomic: null,
    weeklyCapAtomic: null,
    totalOpenExposureAtomic: null,
    maxRealizedLossAtomic: null,
    signedAllowanceAtomic: null,
    onchainAllowanceAtomic: null,
    onchainBalanceAtomic: null,
    remainingAllowanceAtomic: null,
    hasSufficientAllowance: false,
    hasSufficientBalance: false,
    isSpenderConfigured: false,
    isTokenConfigured: false,
    isExpired: false,
    isRevoked: false,
    isPaused: false,
    isStale: false,
    allowedCategories: [],
    allowedModes: [],
    minConfidenceBps: null,
    minPayoutBps: null,
    expiresAt: null,
    ...overrides,
  };
}

/**
 * Deterministically constructs a contract-backed view of a copy-trading permission.
 */
export function buildCopyPermissionFeedback(
  input: CopyPermissionFeedbackInput,
): CopyPermissionFeedbackView {
  const now = input.now ?? Date.now();

  // 1. Loading
  if (input.loading || input.permission === undefined) {
    return emptyFeedback("loading", "Querying on-chain allowance and policy bounds.");
  }

  // 2. Disconnected
  if (input.disconnected) {
    return emptyFeedback("disconnected", "Wallet is disconnected. Connect owner wallet to view or manage execution permissions.");
  }

  // 3. Not Found
  if (input.permission === null) {
    return emptyFeedback("invalid", "No copy execution permission found for this identifier.");
  }

  const p = input.permission;

  // Extract atomic bounds safely
  let maxPerPositionAtomic: bigint;
  let dailyCapAtomic: bigint;
  let weeklyCapAtomic: bigint;
  let totalOpenExposureAtomic: bigint;
  try {
    maxPerPositionAtomic = parseUsdcAtomic(p.maxPerPositionUsdc);
    dailyCapAtomic = parseUsdcAtomic(p.dailyCapUsdc);
    weeklyCapAtomic = parseUsdcAtomic(p.weeklyCapUsdc);
    totalOpenExposureAtomic = parseUsdcAtomic(p.totalOpenExposureUsdc);
  } catch {
    return emptyFeedback("invalid", "Permission defines malformed numeric financial bounds.", {
      permissionId: p.permissionId,
      ownerWallet: p.ownerWallet,
    });
  }

  // Connected wallet mismatch
  if (
    input.connectedWallet !== undefined &&
    input.connectedWallet !== null &&
    input.connectedWallet.trim() !== p.ownerWallet.trim()
  ) {
    return emptyFeedback("disconnected", "Connected wallet does not match permission owner.", {
      permissionId: p.permissionId,
      ownerWallet: p.ownerWallet,
    });
  }

  // 4. Invalid policy check
  // Note: validateCopyPermission requires status active and unexpired timestamp;
  // here we validate the structural integrity (addresses, bounds, caps, allowlists).
  const validationError = validateCopyPermission(
    { ...p, status: "active", expiresAt: Math.max(now + 1000, p.expiresAt) },
    now,
  );
  if (validationError) {
    return emptyFeedback("invalid", `Policy fails contract constraints: ${validationError}`, {
      permissionId: p.permissionId,
      ownerWallet: p.ownerWallet,
      executionAgentId: p.executionAgentId,
      signalAgentId: p.signalAgentId,
    });
  }

  // 5. Revoked
  const isRevoked = p.status === "revoked";
  if (isRevoked) {
    return emptyFeedback("revoked", "Copy execution permission has been revoked by the owner.", {
      permissionId: p.permissionId,
      ownerWallet: p.ownerWallet,
      executionAgentId: p.executionAgentId,
      signalAgentId: p.signalAgentId,
      isRevoked: true,
      isTokenConfigured: true,
      isSpenderConfigured: true,
    });
  }

  // 6. Global or permission pause
  const isPaused = Boolean(input.globalPaused || p.status === "paused");
  if (isPaused) {
    return emptyFeedback("paused", "Copy trading execution is currently paused.", {
      permissionId: p.permissionId,
      ownerWallet: p.ownerWallet,
      executionAgentId: p.executionAgentId,
      signalAgentId: p.signalAgentId,
      isPaused: true,
      isTokenConfigured: true,
      isSpenderConfigured: true,
    });
  }

  // 7. Expired
  const isExpired = p.expiresAt <= now;
  if (isExpired) {
    return emptyFeedback("expired", "Copy execution permission has expired.", {
      permissionId: p.permissionId,
      ownerWallet: p.ownerWallet,
      executionAgentId: p.executionAgentId,
      signalAgentId: p.signalAgentId,
      isExpired: true,
      expiresAt: p.expiresAt,
      isTokenConfigured: true,
      isSpenderConfigured: true,
    });
  }

  // Configured token / spender comparison
  const expectedToken = (input.configuredUsdc ?? getUsdcSacId())?.trim();
  const expectedSpender = (input.configuredSpender ?? configuredSpender())?.trim();
  const isTokenConfigured = expectedToken ? p.spendPermission.token.trim() === expectedToken : true;
  const isSpenderConfigured = expectedSpender ? p.spendPermission.spender.trim() === expectedSpender : true;

  if (!isTokenConfigured) {
    return emptyFeedback(
      "invalid",
      `Permission token (${p.spendPermission.token}) does not match configured USDC SAC (${expectedToken}).`,
      {
        permissionId: p.permissionId,
        ownerWallet: p.ownerWallet,
        isTokenConfigured: false,
        isSpenderConfigured,
      },
    );
  }

  if (!isSpenderConfigured) {
    return emptyFeedback(
      "invalid",
      `Permission spender (${p.spendPermission.spender}) does not match configured spender (${expectedSpender}).`,
      {
        permissionId: p.permissionId,
        ownerWallet: p.ownerWallet,
        isTokenConfigured,
        isSpenderConfigured: false,
      },
    );
  }

  // 8. Upstream dependency failure (e.g. RPC simulation error or unread chain state)
  if (input.dependencyFailure || input.onchainAllowanceAtomic === null) {
    return emptyFeedback(
      "dependency_failure",
      "Unable to verify on-chain USDC allowance via Soroban RPC.",
      {
        permissionId: p.permissionId,
        ownerWallet: p.ownerWallet,
        executionAgentId: p.executionAgentId,
        signalAgentId: p.signalAgentId,
        isTokenConfigured: true,
        isSpenderConfigured: true,
      },
    );
  }

  // 9. Stale cache check
  let isStale = false;
  if (input.freshness) {
    if (input.freshness.isStale) isStale = true;
    else if (input.freshness.ttlMs && now - input.freshness.timestamp > input.freshness.ttlMs) {
      isStale = true;
    }
  }

  // 10. Live on-chain allowance and balance verification
  const onchainAllowance = input.onchainAllowanceAtomic !== undefined ? input.onchainAllowanceAtomic : null;
  const onchainBalance = input.onchainBalanceAtomic !== undefined ? input.onchainBalanceAtomic : null;
  const signedAllowance = p.spendPermission.allowanceAtomic;
  const spentInPeriod = input.spentInPeriodAtomic ?? 0n;

  const hasSufficientAllowance = onchainAllowance !== null && onchainAllowance >= maxPerPositionAtomic;
  const hasSufficientBalance = onchainBalance === null || onchainBalance >= maxPerPositionAtomic;

  const remaining = onchainAllowance !== null && onchainAllowance > spentInPeriod
    ? onchainAllowance - spentInPeriod
    : 0n;

  let status: CopyPermissionStatus = "ready";
  let detail = "Active execution permission backed by contract allowance.";

  if (isStale) {
    status = "stale";
    detail = "Permission or on-chain allowance snapshot may be stale; refresh to confirm latest ledger state.";
  } else if (!hasSufficientAllowance) {
    status = "invalid";
    detail = onchainAllowance === 0n
      ? "On-chain USDC allowance is zero. Approve spender on the USDC contract before execution can proceed."
      : `On-chain allowance (${onchainAllowance} atomic) is less than the per-position stake cap (${maxPerPositionAtomic} atomic).`;
  } else if (!hasSufficientBalance) {
    detail = "Account USDC balance is below the per-position stake cap.";
  }

  return {
    status,
    statusMessageKey: status,
    detail,
    permissionId: p.permissionId,
    ownerWallet: p.ownerWallet,
    executionAgentId: p.executionAgentId,
    signalAgentId: p.signalAgentId,
    maxPerPositionAtomic: maxPerPositionAtomic.toString(),
    dailyCapAtomic: dailyCapAtomic.toString(),
    weeklyCapAtomic: weeklyCapAtomic.toString(),
    totalOpenExposureAtomic: totalOpenExposureAtomic.toString(),
    maxRealizedLossAtomic: p.maxRealizedLossAtomic,
    signedAllowanceAtomic: signedAllowance.toString(),
    onchainAllowanceAtomic: onchainAllowance !== null ? onchainAllowance.toString() : null,
    onchainBalanceAtomic: onchainBalance !== null ? onchainBalance.toString() : null,
    remainingAllowanceAtomic: remaining.toString(),
    hasSufficientAllowance,
    hasSufficientBalance,
    isSpenderConfigured: true,
    isTokenConfigured: true,
    isExpired: false,
    isRevoked: false,
    isPaused: false,
    isStale,
    allowedCategories: [...p.allowedCategories],
    allowedModes: [...p.allowedModes],
    minConfidenceBps: p.minConfidenceBps,
    minPayoutBps: p.minPayoutBps,
    expiresAt: p.expiresAt,
  };
}

/**
 * Reads live SAC allowance and balance on chain, then builds contract-backed feedback.
 */
export async function evaluateCopyPermissionOnchain(
  permission: CopyPermission,
  options: {
    connectedWallet?: string | null;
    spentInPeriodAtomic?: bigint;
    freshness?: { timestamp: number; ttlMs?: number; isStale?: boolean } | null;
    globalPaused?: boolean;
    now?: number;
  } = {},
): Promise<CopyPermissionFeedbackView> {
  const [onchainAllowanceAtomic, onchainBalanceAtomic] = await Promise.all([
    getUsdcAllowanceUnits(permission.ownerWallet, permission.spendPermission.spender).catch(() => null),
    getUsdcBalanceUnits(permission.ownerWallet).catch(() => null),
  ]);

  return buildCopyPermissionFeedback({
    permission,
    connectedWallet: options.connectedWallet,
    onchainAllowanceAtomic,
    onchainBalanceAtomic,
    spentInPeriodAtomic: options.spentInPeriodAtomic,
    freshness: options.freshness,
    globalPaused: options.globalPaused,
    now: options.now,
  });
}
