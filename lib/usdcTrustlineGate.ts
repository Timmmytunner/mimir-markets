import type { TrustlineStatus } from "@/lib/stellar-trustline";

export type UsdcTrustlineAction =
  | "create"
  | "rematch"
  | "accept"
  | "mirror"
  | "payout"
  | "withdraw"
  | "fees";

export type UsdcTrustlineGateStatus =
  | "ready"
  | "missing"
  | "unfunded"
  | "loading"
  | "stale"
  | "dependency_failure"
  | "disconnected"
  | "cannot_sign";

export type UsdcTrustlineGateMessageKey =
  | "connectWalletFirst"
  | "cannotSign"
  | "trustlineChecking"
  | "trustlineStale"
  | "trustlineCheckFailed"
  | "trustlineMissing"
  | "trustlineUnfunded"
  | "trustlineReady";

export type UsdcTrustlineGateInput = {
  action: UsdcTrustlineAction;
  status: TrustlineStatus;
  loading: boolean;
  stale: boolean;
  isConnected: boolean;
  hasSigner: boolean;
};

export type UsdcTrustlineGateResult = {
  action: UsdcTrustlineAction;
  allowed: boolean;
  status: UsdcTrustlineGateStatus;
  messageKey: UsdcTrustlineGateMessageKey;
};

export function evaluateUsdcTrustlineGate(
  input: UsdcTrustlineGateInput,
): UsdcTrustlineGateResult {
  if (!input.isConnected) {
    return {
      action: input.action,
      allowed: false,
      status: "disconnected",
      messageKey: "connectWalletFirst",
    };
  }

  if (!input.hasSigner) {
    return {
      action: input.action,
      allowed: false,
      status: "cannot_sign",
      messageKey: "cannotSign",
    };
  }

  if (input.loading) {
    return {
      action: input.action,
      allowed: false,
      status: "loading",
      messageKey: "trustlineChecking",
    };
  }

  if (input.stale) {
    return {
      action: input.action,
      allowed: false,
      status: "stale",
      messageKey: "trustlineStale",
    };
  }

  if (input.status === "missing") {
    return {
      action: input.action,
      allowed: false,
      status: "missing",
      messageKey: "trustlineMissing",
    };
  }

  if (input.status === "unfunded") {
    return {
      action: input.action,
      allowed: false,
      status: "unfunded",
      messageKey: "trustlineUnfunded",
    };
  }

  if (input.status === "unknown") {
    return {
      action: input.action,
      allowed: false,
      status: "dependency_failure",
      messageKey: "trustlineCheckFailed",
    };
  }

  return {
    action: input.action,
    allowed: true,
    status: "ready",
    messageKey: "trustlineReady",
  };
}

export function usdcTrustlineGateFixture(
  overrides: Partial<UsdcTrustlineGateInput> = {},
): UsdcTrustlineGateInput {
  return {
    action: "create",
    status: "ready",
    loading: false,
    stale: false,
    isConnected: true,
    hasSigner: true,
    ...overrides,
  };
}
