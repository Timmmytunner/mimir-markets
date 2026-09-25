/**
 * Async panel loading lifecycle for dashboard / explorer / council / market panels.
 *
 * Keeps UI skeletons honest about request identity: a late response from a
 * cancelled or superseded fetch must not overwrite fresher panel data, and
 * dependency failures stay explicit (no silent empty states that look funded).
 */

export type AsyncPanelKind = "dashboard" | "explorer" | "council" | "market";

export type AsyncPanelPhase =
  | "idle"
  | "loading"
  | "ready"
  | "invalid"
  | "stale"
  | "duplicated"
  | "cancelled"
  | "dependency_failure";

export type AsyncPanelRequest = {
  /** Opaque request id (claim id, wallet address hash, filter key, etc.). */
  key: string;
  /** Monotonic generation — bump on every new fetch for the same panel. */
  generation: number;
  /** Optional dependency that must be present before fetch (e.g. wallet). */
  dependencyKey?: string | null;
};

export type AsyncPanelState = {
  kind: AsyncPanelKind;
  phase: AsyncPanelPhase;
  requestKey: string | null;
  generation: number;
  /** Wall-clock ms when the last successful payload landed; null if never. */
  readyAtMs: number | null;
  /** Human-readable reason for invalid / dependency_failure / cancelled. */
  reason: string | null;
};

export const ASYNC_PANEL_STALE_AFTER_MS = 30_000;

export function createAsyncPanelState(
  kind: AsyncPanelKind,
): AsyncPanelState {
  return {
    kind,
    phase: "idle",
    requestKey: null,
    generation: 0,
    readyAtMs: null,
    reason: null,
  };
}

export function beginAsyncPanelLoad(
  state: AsyncPanelState,
  request: AsyncPanelRequest,
): AsyncPanelState {
  if (request.dependencyKey === null || request.dependencyKey === "") {
    return {
      ...state,
      phase: "dependency_failure",
      requestKey: request.key,
      generation: request.generation,
      reason: "missing_dependency",
    };
  }

  if (!request.key.trim()) {
    return {
      ...state,
      phase: "invalid",
      requestKey: request.key,
      generation: request.generation,
      reason: "invalid_request_key",
    };
  }

  // Same key + same generation while already in-flight → duplicate submit.
  if (
    state.phase === "loading" &&
    state.requestKey === request.key &&
    state.generation === request.generation
  ) {
    return {
      ...state,
      phase: "duplicated",
      reason: "duplicate_in_flight",
    };
  }

  return {
    ...state,
    phase: "loading",
    requestKey: request.key,
    generation: request.generation,
    reason: null,
  };
}

export type AsyncPanelSettleInput = {
  requestKey: string;
  generation: number;
  atMs: number;
  cancelled?: boolean;
  dependencyFailed?: boolean;
  invalid?: boolean;
};

/**
 * Apply a fetch outcome. Late / superseded responses are ignored so a cancelled
 * or older generation cannot clobber the active panel.
 */
export function settleAsyncPanelLoad(
  state: AsyncPanelState,
  input: AsyncPanelSettleInput,
): AsyncPanelState {
  const matchesActive =
    state.requestKey === input.requestKey &&
    state.generation === input.generation;

  if (!matchesActive) {
    // Stale response for a previous generation — keep current state, mark note
    // only when we are still loading something else.
    if (state.phase === "loading") {
      return { ...state, reason: "ignored_stale_response" };
    }
    return state;
  }

  if (input.cancelled) {
    return {
      ...state,
      phase: "cancelled",
      reason: "request_cancelled",
    };
  }

  if (input.dependencyFailed) {
    return {
      ...state,
      phase: "dependency_failure",
      reason: "dependency_failed",
    };
  }

  if (input.invalid) {
    return {
      ...state,
      phase: "invalid",
      reason: "invalid_payload",
    };
  }

  return {
    ...state,
    phase: "ready",
    readyAtMs: input.atMs,
    reason: null,
  };
}

/** Mark ready data as stale after the freshness window (cache / poll boundary). */
export function markAsyncPanelStale(
  state: AsyncPanelState,
  nowMs: number,
  staleAfterMs: number = ASYNC_PANEL_STALE_AFTER_MS,
): AsyncPanelState {
  if (state.phase !== "ready" || state.readyAtMs == null) {
    return state;
  }
  if (nowMs - state.readyAtMs < staleAfterMs) {
    return state;
  }
  return { ...state, phase: "stale", reason: "freshness_elapsed" };
}

/** True when the UI should render a loading skeleton (not error/empty). */
export function shouldShowAsyncPanelSkeleton(state: AsyncPanelState): boolean {
  return state.phase === "loading" || state.phase === "duplicated";
}

/**
 * Whether an arriving response may update panel data.
 * Cancelled / superseded / wrong-generation payloads must be dropped.
 */
export function canCommitAsyncPanelPayload(
  state: AsyncPanelState,
  requestKey: string,
  generation: number,
): boolean {
  if (state.phase === "cancelled") return false;
  return (
    state.requestKey === requestKey &&
    state.generation === generation &&
    (state.phase === "loading" || state.phase === "duplicated" || state.phase === "stale")
  );
}
