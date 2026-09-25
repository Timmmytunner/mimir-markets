/**
 * Pure state-machine logic for the VS detail page (Issue #61).
 *
 * Kept framework-free so it can be unit-tested with plain `node:test` without
 * a DOM or React renderer.  The `useVsDetail` hook is a thin wrapper that calls
 * these functions and wires the resulting state into React state setters.
 *
 * ── Responsibilities ──────────────────────────────────────────────────────────
 *  - Define the canonical phase enum and transition rules.
 *  - Track fetch-attempt counters and decide when to give up.
 *  - Validate vsId before any fetch is initiated.
 *  - Guard against stale-generation responses.
 *  - Determine whether a challenge-stake value needs auto-seeding.
 */

import type { VSData } from "./contract";
import type { VSCacheFreshness } from "./vs-freshness";

// ── Phase ─────────────────────────────────────────────────────────────────────

export type VsDetailPhase =
  | "loading"
  | "ready"
  | "stale"
  | "invalid"
  | "dependency_failure"
  | "not_found";

// ── State ─────────────────────────────────────────────────────────────────────

export interface VsDetailState {
  phase: VsDetailPhase;
  vs: VSData | null;
  cache: VSCacheFreshness | null;
  /** Monotonic generation counter; incremented on each new fetch attempt. */
  generation: number;
  /** Fetch attempts since the last successful data load. */
  fetchAttempts: number;
  /** Whether a manual refresh is in flight. */
  refreshing: boolean;
  /**
   * The user's challenger stake input.  Empty string = not set by user.
   * Auto-seeded to `vs.stake_amount` on first load only.
   */
  challengeStake: string;
  /** True once the user has typed a custom stake value. */
  userHasSetStake: boolean;
}

// ── Constants ─────────────────────────────────────────────────────────────────

export const VS_DETAIL_POLL_INTERVAL_MS = 10_000;
export const VS_DETAIL_MAX_ATTEMPTS = 12;

// ── Helpers ───────────────────────────────────────────────────────────────────

export function isValidVsId(vsId: number): boolean {
  return Number.isInteger(vsId) && vsId !== 0;
}

export function createVsDetailState(vsId: number): VsDetailState {
  return {
    phase: isValidVsId(vsId) ? "loading" : "invalid",
    vs: null,
    cache: null,
    generation: 0,
    fetchAttempts: 0,
    refreshing: false,
    challengeStake: "",
    userHasSetStake: false,
  };
}

// ── Transitions ───────────────────────────────────────────────────────────────

/** Begin a new fetch — increments generation and marks the phase loading. */
export function beginVsDetailFetch(
  state: VsDetailState,
  opts: { isManual?: boolean } = {},
): VsDetailState {
  if (!isValidVsId(state.generation) && state.phase === "invalid") {
    return state;
  }
  return {
    ...state,
    generation: state.generation + 1,
    refreshing: opts.isManual ?? false,
  };
}

export type VsDetailFetchSuccess = {
  kind: "success";
  generation: number;
  vs: VSData;
  cache: VSCacheFreshness | null;
};

export type VsDetailFetchEmpty = {
  kind: "empty";
  generation: number;
  /** Optional pending VS from localStorage. */
  pending: VSData | null;
};

export type VsDetailFetchError = {
  kind: "error";
  generation: number;
};

export type VsDetailFetchOutcome =
  | VsDetailFetchSuccess
  | VsDetailFetchEmpty
  | VsDetailFetchError;

/**
 * Apply the result of a completed fetch.
 *
 * Stale generations (outcome.generation !== state.generation) are silently
 * ignored — the state is returned unchanged.
 */
export function applyVsDetailFetchOutcome(
  state: VsDetailState,
  outcome: VsDetailFetchOutcome,
  maxAttempts = VS_DETAIL_MAX_ATTEMPTS,
): VsDetailState {
  // Generation guard: drop late / superseded responses.
  if (outcome.generation !== state.generation) {
    return state;
  }

  switch (outcome.kind) {
    case "success": {
      const autoStake =
        !state.userHasSetStake && state.vs === null
          ? String(outcome.vs.stake_amount)
          : state.challengeStake;
      return {
        ...state,
        phase: "ready",
        vs: outcome.vs,
        cache: outcome.cache,
        fetchAttempts: 0,
        refreshing: false,
        challengeStake: autoStake,
      };
    }

    case "empty": {
      const next = state.fetchAttempts + 1;
      const gaveUp = next >= maxAttempts;
      const nextPhase: VsDetailPhase = gaveUp
        ? state.phase === "loading"
          ? "not_found"
          : state.phase
        : state.phase;

      return {
        ...state,
        phase: nextPhase,
        vs: outcome.pending ?? state.vs,
        fetchAttempts: next,
        refreshing: false,
      };
    }

    case "error": {
      const next = state.fetchAttempts + 1;
      const gaveUp = next >= maxAttempts;
      const nextPhase: VsDetailPhase = gaveUp
        ? state.phase === "loading"
          ? "dependency_failure"
          : state.phase
        : state.phase;

      return {
        ...state,
        phase: nextPhase,
        fetchAttempts: next,
        refreshing: false,
      };
    }
  }
}

/** Reset all mutable state when the vsId route parameter changes. */
export function resetVsDetailState(vsId: number): VsDetailState {
  return createVsDetailState(vsId);
}

/** Update the user's stake input, marking it as manually set. */
export function setVsDetailChallengeStake(
  state: VsDetailState,
  value: string,
): VsDetailState {
  return {
    ...state,
    challengeStake: value,
    userHasSetStake: true,
  };
}

/** Clear the stake input and allow the next fetch to re-seed it automatically. */
export function resetVsDetailChallengeStake(state: VsDetailState): VsDetailState {
  return {
    ...state,
    challengeStake: "",
    userHasSetStake: false,
  };
}
