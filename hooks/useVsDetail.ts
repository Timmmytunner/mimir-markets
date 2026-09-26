"use client";

/**
 * useVsDetail — background-safe polling hook for a single market detail page.
 *
 * Design goals (Issue #61):
 *
 *  1. **Background-safe polling.** When the browser tab is hidden polling
 *     pauses immediately; it resumes the instant the tab becomes visible,
 *     firing one refresh right away so data is never more than one tick stale
 *     on reveal.
 *
 *  2. **Generation guard.** Every new fetch starts with an incremented
 *     generation number.  A late response from a cancelled or superseded
 *     request is silently dropped — it can never clobber a fresher snapshot.
 *
 *  3. **Freshness exposure.** The `cache` field from `/api/vs/[id]` is
 *     threaded through and returned for consumption by `<CacheFreshnessPill />`
 *     and `<CacheFreshnessControls />`.
 *
 *  4. **User-context preservation.** `challengeStake` entered by the user
 *     survives background refreshes.  The hook only ever writes `challengeStake`
 *     when (a) it has never been set or (b) the caller explicitly resets it via
 *     `resetChallengeStake`.
 *
 *  5. **vs-id change.** When the `vsId` prop changes every piece of state is
 *     reset atomically — no stale data can leak between markets.
 *
 *  6. **Manual refresh.** `refresh()` bumps the generation and fetches
 *     immediately, ignoring the poll interval.
 *
 *  7. **Dependency failure.** When `vsId` is invalid (NaN, ≤ 0) the hook
 *     moves into `dependency_failure` rather than firing empty requests.
 *
 * The hook is purely logic.  No JSX, no toast side-effects — all of that stays
 * in the page component so the boundary between state and rendering is clear.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { getVSFull } from "@/lib/contract";
import { getPendingVS } from "@/lib/pending-vs";
import { SAMPLE_VS } from "@/lib/sampleVs";
import {
  MOCK_CREATED_VS_ID,
  mergeMockSnapshotIntoVs,
  readCreateMockSnapshot,
} from "@/lib/mockVsCreate";
import {
  isValidVsId,
  VS_DETAIL_POLL_INTERVAL_MS,
  VS_DETAIL_MAX_ATTEMPTS,
} from "@/lib/vs-detail-state";
import type { VSData } from "@/lib/contract";
import type { VSCacheFreshness } from "@/lib/vs-freshness";

// Re-export so consumers only need to import from one place.
export { VS_DETAIL_POLL_INTERVAL_MS, VS_DETAIL_MAX_ATTEMPTS } from "@/lib/vs-detail-state";
import type { VsDetailPhase } from "@/lib/vs-detail-state";
export type { VsDetailPhase };

// ── Types ─────────────────────────────────────────────────────────────────────

export interface UseVsDetailOptions {
  /** The market id from the route.  May be NaN for invalid routes. */
  vsId: number;
  /** Connected wallet address, used for viewer-specific reads.  May be null. */
  address: string | null | undefined;
  /** Optional private invite key (from URL or localStorage). */
  inviteKey?: string;
  /**
   * When `true` (sample / design-preview markets) the hook loads the static
   * fixture and skips all polling.
   */
  isSampleVS?: boolean;
}

export interface UseVsDetailResult {
  /** Current phase. See {@link VsDetailPhase} for the full lifecycle. */
  phase: VsDetailPhase;
  /**
   * The latest available market snapshot.  May be `null` during initial load
   * or on not-found.  Always present once the first successful fetch completes.
   */
  vs: VSData | null;
  /**
   * Freshness metadata from the last `/api/vs/[id]` response.  Null for
   * sample markets and before the first successful fetch.
   */
  cache: VSCacheFreshness | null;
  /**
   * Monotonic number of polling attempts since the last successful fetch.
   * The page uses this to decide between "loading" and "re-trying" copy.
   */
  fetchAttempts: number;
  /**
   * True while a manual or automatic refresh is in flight.  The refresh
   * button uses this to show the spinner without changing the main phase.
   */
  refreshing: boolean;
  /**
   * Challenger stake input value, preserved across background refreshes.
   * Initialized to the empty string; auto-seeded to `vs.stake_amount` on
   * first load if the user has not typed anything yet.
   */
  challengeStake: string;
  /** Update the user's stake input. */
  setChallengeStake: (value: string) => void;
  /** Reset challengeStake to the empty string (e.g. after a successful join). */
  resetChallengeStake: () => void;
  /**
   * Trigger an immediate refresh and bump the generation counter.
   * Returns a Promise that resolves once the fetch completes (or fails).
   */
  refresh: () => Promise<void>;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/** Holds the mutable generation counter outside React state to avoid stale closures. */
type GenerationRef = { current: number };

// ── Hook implementation ───────────────────────────────────────────────────────

export function useVsDetail({
  vsId,
  address,
  inviteKey = "",
  isSampleVS = false,
}: UseVsDetailOptions): UseVsDetailResult {
  // ── Phase and data ────────────────────────────────────────────────────────

  const [phase, setPhase] = useState<VsDetailPhase>(() =>
    isValidVsId(vsId) ? "loading" : "invalid"
  );
  const [vs, setVs] = useState<VSData | null>(null);
  const [cache, setCache] = useState<VSCacheFreshness | null>(null);
  const [fetchAttempts, setFetchAttempts] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  // ── User context: challenge stake ─────────────────────────────────────────

  const [challengeStake, setChallengeStakeRaw] = useState("");

  /**
   * Track whether the user has typed a custom value.  If they haven't we
   * auto-seed it to the market's stake_amount on first data load.
   */
  const userHasSetStake = useRef(false);

  const setChallengeStake = useCallback((value: string) => {
    userHasSetStake.current = true;
    setChallengeStakeRaw(value);
  }, []);

  const resetChallengeStake = useCallback(() => {
    userHasSetStake.current = false;
    setChallengeStakeRaw("");
  }, []);

  // ── Generation guard ──────────────────────────────────────────────────────

  /**
   * Every new fetch (poll tick or manual refresh) increments this counter.
   * A response that arrives with an older generation is silently discarded.
   */
  const generationRef = useRef(0);

  // ── vsId change reset ─────────────────────────────────────────────────────

  /**
   * Track the previous vsId so we can reset when the route changes without
   * stomping on the initial render.
   */
  const prevVsIdRef = useRef<number | null>(null);

  useEffect(() => {
    if (prevVsIdRef.current !== null && prevVsIdRef.current !== vsId) {
      // Route changed — reset everything atomically.
      generationRef.current += 1;
      userHasSetStake.current = false;
      setChallengeStakeRaw("");
      setVs(null);
      setCache(null);
      setFetchAttempts(0);
      setRefreshing(false);
      setPhase(isValidVsId(vsId) ? "loading" : "invalid");
    }
    prevVsIdRef.current = vsId;
  }, [vsId]);

  // ── Core fetch ────────────────────────────────────────────────────────────

  const fetchVs = useCallback(
    async (opts: { isManual?: boolean } = {}): Promise<void> => {
      if (!isValidVsId(vsId)) {
        setPhase("invalid");
        return;
      }

      // Sample / design-preview: load from static fixture, no polling.
      if (isSampleVS) {
        let data = SAMPLE_VS[vsId];
        if (!data) {
          setPhase("not_found");
          return;
        }
        // Merge the localStorage mock snapshot for the ?demo=1 create flow.
        if (vsId === MOCK_CREATED_VS_ID) {
          const snap = readCreateMockSnapshot();
          if (snap) {
            data = mergeMockSnapshotIntoVs(data, snap);
          }
        }
        setVs(data);
        setCache(null);
        setPhase("ready");
        return;
      }

      // Claim a generation slot for this fetch.
      generationRef.current += 1;
      const myGeneration = generationRef.current;

      if (opts.isManual) {
        setRefreshing(true);
      }

      try {
        const snapshot = await getVSFull(vsId, {
          inviteKey: inviteKey || undefined,
          viewerAddress: address ?? undefined,
        });

        // Drop stale responses.
        if (myGeneration !== generationRef.current) {
          return;
        }

        if (snapshot.item) {
          setVs((prev) => {
            // Auto-seed challengeStake only on the very first load.
            if (!userHasSetStake.current && prev === null) {
              setChallengeStakeRaw(String(snapshot.item!.stake_amount));
            }
            return snapshot.item!;
          });
          setCache(snapshot.cache ?? null);
          setFetchAttempts(0);
          setPhase("ready");
          setRefreshing(false);
          return;
        }

        // No data from the API — try the optimistic pending store.
        const pending = getPendingVS(vsId);
        if (pending) {
          if (myGeneration !== generationRef.current) return;
          setVs(pending);
          setCache(null);
          setPhase("ready");
          setRefreshing(false);
          // Keep polling until on-chain data arrives.
        }

        // Still nothing: count the attempt and decide whether to give up.
        setFetchAttempts((prev) => {
          const next = prev + 1;
          if (next >= VS_DETAIL_MAX_ATTEMPTS) {
            setPhase((current) =>
              // Only downgrade once — don't clobber a "ready" state that a
              // concurrent poll just wrote.
              current === "loading" ? "not_found" : current
            );
          }
          return next;
        });
      } catch {
        if (myGeneration !== generationRef.current) return;
        setRefreshing(false);
        setFetchAttempts((prev) => {
          const next = prev + 1;
          if (next >= VS_DETAIL_MAX_ATTEMPTS) {
            setPhase((current) =>
              current === "loading" ? "dependency_failure" : current
            );
          }
          return next;
        });
      } finally {
        if (myGeneration === generationRef.current) {
          setRefreshing(false);
        }
      }
    },
    [vsId, address, inviteKey, isSampleVS]
  );

  // ── Manual refresh ────────────────────────────────────────────────────────

  const refresh = useCallback(async (): Promise<void> => {
    await fetchVs({ isManual: true });
  }, [fetchVs]);

  // ── Poll while tab is visible ─────────────────────────────────────────────

  useEffect(() => {
    if (!isValidVsId(vsId) || isSampleVS) {
      if (!isValidVsId(vsId)) setPhase("invalid");
      return;
    }

    // Initial load.
    void fetchVs();

    const intervalId = setInterval(() => {
      // Only poll when the tab is in the foreground.
      if (document.visibilityState === "hidden") return;
      void fetchVs();
    }, VS_DETAIL_POLL_INTERVAL_MS);

    // Resume immediately when the tab becomes visible so users never see
    // more than one poll-interval worth of stale data after a background stay.
    function handleVisibilityChange() {
      if (document.visibilityState === "visible") {
        void fetchVs();
      }
    }

    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      clearInterval(intervalId);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      // Invalidate any in-flight fetch so it doesn't land after cleanup.
      generationRef.current += 1;
    };
    // fetchVs is stable across vsId changes because the useEffect above resets
    // the generation counter, so including it here is safe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchVs, isSampleVS, vsId]);

  // ── Return ────────────────────────────────────────────────────────────────

  return {
    phase,
    vs,
    cache,
    fetchAttempts,
    refreshing,
    challengeStake,
    setChallengeStake,
    resetChallengeStake,
    refresh,
  };
}
