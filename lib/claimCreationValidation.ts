/**
 * Client-side claim-creation validation that runs **before** wallet signing.
 *
 * Chain remains the source of truth for funding and settlement; this module only
 * blocks clearly invalid, disconnected, stale, or dependency-failed drafts so
 * users get contract-backed feedback without spending gas on a revert.
 *
 * Status vocabulary (as applicable to the create form):
 * - `ok` — draft is ready to sign (or demo-create)
 * - `invalid` — form fields fail schema / business rules
 * - `disconnected` — wallet not connected (non-demo)
 * - `cannot_sign` — connected address cannot produce a signature
 * - `loading` — a dependency (e.g. moderation) is still in flight
 * - `stale` — a prior approval no longer matches the current draft
 * - `dependency_failure` — mode/policy/contract preflight rejected the draft
 */

import { MIN_STAKE, normalizeResolutionSource } from "@/lib/constants";
import {
  SETTLEMENT_MODE_POLICY,
  validateMode,
  type SettlementMode,
} from "@/lib/market-modes";

const MARKET_TYPES = ["binary", "moneyline", "custom"] as const;
export type ClaimCreationMarketType = (typeof MARKET_TYPES)[number];

export type ClaimCreationValidationStatus =
  | "ok"
  | "invalid"
  | "disconnected"
  | "cannot_sign"
  | "loading"
  | "stale"
  | "dependency_failure";

/**
 * Toast / i18n keys already used by the VS create form. Kept as string literals
 * so the page can call `t(result.messageKey)` without a parallel map.
 */
export type ClaimCreationMessageKey =
  | "fillAllFields"
  | "connectWalletFirst"
  | "walletCannotSign"
  | "invalidStakeMin"
  | "completeExactDeadline"
  | "invalidDeadline"
  | "sourceRequired"
  | "settlementRuleRequired"
  | "moderationCheckFailed"
  | "moderationNeedsReview";

export type ClaimCreationModerationGate = {
  enabled: boolean;
  loading: boolean;
  /** Fingerprint of the draft fields currently on the form. */
  currentKey: string;
  /** Fingerprint last approved with decision === "allow". Empty if never. */
  approvedKey?: string;
  decision?: "" | "allow" | "review" | "block";
};

export type ClaimCreationDraftInput = {
  question: string;
  creatorPosition: string;
  opponentPosition: string;
  /** Raw or already-normalized resolution URL; re-normalized here. */
  resolutionUrl: string;
  settlementRule: string;
  requiresExplicitSettlementRule: boolean;
  stake: number;
  /** Defaults to `MIN_STAKE` when omitted. */
  minStake?: number;
  /** `datetime-local` value or empty. */
  customDeadline: string;
  marketType: string;
  settlementMode: SettlementMode | string;
  poolSlots: number;
  challengerPayoutBps: number;
  isDemo: boolean;
  isConnected: boolean;
  address: string | null | undefined;
  hasSigner: boolean;
  moderation?: ClaimCreationModerationGate;
  /** Injectable clock for tests (ms). */
  nowMs?: number;
};

export type ClaimCreationParsedDraft = {
  question: string;
  creatorPosition: string;
  opponentPosition: string;
  resolutionUrl: string;
  settlementRule: string;
  deadlineTimestamp: number;
  stake: number;
  categoryReady: true;
  marketType: ClaimCreationMarketType;
  maxChallengers: number;
  challengerPayoutBps: number;
};

export type ClaimCreationValidationResult = {
  status: ClaimCreationValidationStatus;
  ok: boolean;
  messageKey?: ClaimCreationMessageKey;
  messageParams?: Record<string, string | number>;
  /** Raw mode-policy error when status is dependency_failure. */
  detail?: string;
  parsed?: ClaimCreationParsedDraft;
};

function normalizeMarketType(value: string): ClaimCreationMarketType {
  return MARKET_TYPES.includes(value as ClaimCreationMarketType)
    ? (value as ClaimCreationMarketType)
    : "binary";
}

/**
 * Validate a claim draft before requesting a wallet signature.
 *
 * Money (`stake`), wallet connectivity/signing, and mode policy are checked
 * explicitly. Analytics envelopes are intentionally out of scope — callers must
 * not put wallet addresses or stake amounts into client analytics until this
 * returns `ok`.
 */
export function validateClaimCreationBeforeSign(
  input: ClaimCreationDraftInput
): ClaimCreationValidationResult {
  const nowMs = input.nowMs ?? Date.now();
  const minStake = input.minStake ?? MIN_STAKE;
  const question = input.question.trim();
  const creatorPosition = input.creatorPosition.trim();
  const opponentPosition = input.opponentPosition.trim();
  const settlementRule = input.settlementRule.trim();
  const resolutionUrl = normalizeResolutionSource(input.resolutionUrl);

  if (input.moderation?.enabled && input.moderation.loading) {
    return {
      status: "loading",
      ok: false,
      messageKey: "moderationCheckFailed",
      detail: "Claim moderation is still running.",
    };
  }

  if (!question || !creatorPosition || !opponentPosition) {
    return { status: "invalid", ok: false, messageKey: "fillAllFields" };
  }

  if (!input.isDemo && (!input.isConnected || !input.address)) {
    return { status: "disconnected", ok: false, messageKey: "connectWalletFirst" };
  }

  if (!input.isDemo && !input.hasSigner) {
    return { status: "cannot_sign", ok: false, messageKey: "walletCannotSign" };
  }

  if (!Number.isFinite(input.stake) || input.stake < minStake) {
    return {
      status: "invalid",
      ok: false,
      messageKey: "invalidStakeMin",
      messageParams: { amount: minStake },
    };
  }

  if (!input.customDeadline) {
    return {
      status: "invalid",
      ok: false,
      messageKey: "completeExactDeadline",
    };
  }

  const deadlineTimestamp = Math.floor(new Date(input.customDeadline).getTime() / 1000);
  const nowTs = Math.floor(nowMs / 1000);

  if (!Number.isFinite(deadlineTimestamp) || deadlineTimestamp <= nowTs) {
    // Past / non-finite deadlines are treated as stale when the field is set:
    // the user had a value that is no longer actionable at submit time.
    const status: ClaimCreationValidationStatus =
      Number.isFinite(deadlineTimestamp) && deadlineTimestamp > 0 ? "stale" : "invalid";
    return { status, ok: false, messageKey: "invalidDeadline" };
  }

  if (!resolutionUrl) {
    return { status: "invalid", ok: false, messageKey: "sourceRequired" };
  }

  if (input.requiresExplicitSettlementRule && settlementRule.length < 16) {
    return {
      status: "invalid",
      ok: false,
      messageKey: "settlementRuleRequired",
    };
  }

  const marketType = normalizeMarketType(input.marketType);
  const settlementMode = input.settlementMode as SettlementMode;
  const policy = SETTLEMENT_MODE_POLICY[settlementMode];
  const maxChallengers =
    policy?.maxChallengers ?? Math.max(2, Math.floor(input.poolSlots));
  const challengerPayoutBps =
    settlementMode === "fixed_odds" ? input.challengerPayoutBps : 0;

  const modeCheck = validateMode({
    subjectType: marketType,
    settlementMode,
    maxChallengers,
    creatorStake: input.stake,
    challengerPayoutBps,
  });

  if (!modeCheck.ok) {
    return {
      status: "dependency_failure",
      ok: false,
      detail: modeCheck.errors[0],
    };
  }

  if (input.moderation?.enabled) {
    const { currentKey, approvedKey = "", decision = "" } = input.moderation;
    if (decision === "allow" && approvedKey && approvedKey !== currentKey) {
      return {
        status: "stale",
        ok: false,
        messageKey: "moderationNeedsReview",
        detail: "Moderation approval no longer matches the current draft.",
        messageParams: { codesLabel: "" },
      };
    }
  }

  return {
    status: "ok",
    ok: true,
    parsed: {
      question,
      creatorPosition,
      opponentPosition,
      resolutionUrl,
      settlementRule,
      deadlineTimestamp,
      stake: input.stake,
      categoryReady: true,
      marketType,
      maxChallengers,
      challengerPayoutBps,
    },
  };
}

/** Fixture builders for tests / storybook-style demos. */
export function claimCreationDraftFixture(
  overrides: Partial<ClaimCreationDraftInput> = {}
): ClaimCreationDraftInput {
  const nowMs = overrides.nowMs ?? 1_800_000_000_000;
  return {
    question: "Will BTC close above $100k before next Friday at 23:59 UTC?",
    creatorPosition: "BTC closes above $100k",
    opponentPosition: "BTC stays at or below $100k",
    resolutionUrl: "https://coingecko.com/en/coins/bitcoin",
    settlementRule:
      "Resolve this using the linked source price exactly at the deadline timestamp.",
    requiresExplicitSettlementRule: false,
    stake: MIN_STAKE,
    minStake: MIN_STAKE,
    customDeadline: new Date(nowMs + 48 * 60 * 60 * 1000).toISOString().slice(0, 16),
    marketType: "binary",
    settlementMode: "pool",
    poolSlots: 8,
    challengerPayoutBps: 0,
    isDemo: false,
    isConnected: true,
    address: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    hasSigner: true,
    nowMs,
    ...overrides,
  };
}
