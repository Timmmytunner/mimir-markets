"use client";

/**
 * CouncilVoteWidget
 *
 * Inline panel for the /vs/[id] page that shows where each of the 10
 * council personas stands on a single claim. Reads /api/vs/[id]/council
 * (pure on-chain) and renders a grid: persona pill + ✓/✗ + stake amount.
 *
 * No LLM calls happen here — the worker decides off-band and the result
 * shows up as a real ClaimChallenged event.
 */

import { useEffect, useRef, useState } from "react";
import { getExplorerTxUrl } from "@/lib/stellar";
import { openPeepsAvatar } from "@/lib/avatars";
import { CouncilPanelSkeleton } from "@/components/ui/AsyncPanelSkeleton";
import {
  beginAsyncPanelLoad,
  canCommitAsyncPanelPayload,
  createAsyncPanelState,
  markAsyncPanelStale,
  settleAsyncPanelLoad,
  shouldShowAsyncPanelSkeleton,
} from "@/lib/asyncPanelLoading";
import CacheFreshnessPill from "@/components/CacheFreshnessPill";
import type { VSCacheFreshness } from "@/lib/vs-freshness";

interface PersonaVote {
  slug:        string;
  displayName: string;
  emoji:       string;
  archetype:   string;
  accent: {
    border: string;
    bg:     string;
    text:   string;
    chip:   string;
  };
  staked:      boolean;
  stakeUsdc:   number;
  txHash:      string | null;
  ledger:      number | null;
}

interface CouncilResponse {
  claimId:     number;
  total:       number;
  stakedCount: number;
  totalUsdc:   number;
  votes:       PersonaVote[];
  cache?:      VSCacheFreshness | null;
}

export default function CouncilVoteWidget({ claimId }: { claimId: number }) {
  const [data, setData] = useState<CouncilResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [panel, setPanel] = useState(() => createAsyncPanelState("council"));
  const generationRef = useRef(0);

  useEffect(() => {
    const requestKey = `council:${claimId}`;
    const generation = generationRef.current + 1;
    generationRef.current = generation;

    setPanel((prev) =>
      beginAsyncPanelLoad(prev, {
        key: requestKey,
        generation,
        dependencyKey: Number.isFinite(claimId) ? String(claimId) : null,
      }),
    );
    setError(null);
    setData(null);

    let cancelled = false;

    fetch(`/api/vs/${claimId}/council`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<CouncilResponse>;
      })
      .then((body) => {
        if (cancelled) return;
        const invalid = !body || typeof body.total !== "number";
        setPanel((prev) => {
          if (!canCommitAsyncPanelPayload(prev, requestKey, generation)) {
            return prev;
          }
          const next = settleAsyncPanelLoad(prev, {
            requestKey,
            generation,
            atMs: Date.now(),
            invalid,
          });
          if (next.phase === "ready" && !invalid) {
            setData(body);
          }
          return next;
        });
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setPanel((prev) =>
          settleAsyncPanelLoad(prev, {
            requestKey,
            generation,
            atMs: Date.now(),
            dependencyFailed: true,
          }),
        );
        setError(err.message);
      });

    return () => {
      cancelled = true;
      setPanel((prev) =>
        settleAsyncPanelLoad(prev, {
          requestKey,
          generation,
          atMs: Date.now(),
          cancelled: true,
        }),
      );
    };
  }, [claimId]);

  useEffect(() => {
    const timer = setInterval(() => {
      setPanel((prev) => markAsyncPanelStale(prev, Date.now()));
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  if (shouldShowAsyncPanelSkeleton(panel)) {
    return <CouncilPanelSkeleton />;
  }

  if (error || !data) {
    return null; // fail-quiet — the claim page still works without this widget
  }

  if (data.total === 0) {
    return null; // no council in this deploy
  }

  return (
    <section className="rounded-2xl border border-pv-border/30 bg-pv-surface/70 p-5 lg:min-h-[20rem]">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex items-center gap-3">
          <div>
            <div className="text-[11px] font-mono uppercase tracking-[0.18em] text-pv-emerald">Council verdict</div>
            <p className="mt-0.5 text-[12px] text-pv-muted">
              Where each of the {data.total} AI personas stands on this claim. ✓ means they staked the challenger side.
            </p>
          </div>
          {data.cache ? (
            <div className="ml-auto flex items-center gap-2">
              <CacheFreshnessPill freshness={panel.phase === "stale" ? { ...data.cache, status: "stale" } : data.cache} />
            </div>
          ) : null}
        </div>
        <div className="font-mono text-[11px] uppercase tracking-[0.16em] text-pv-muted">
          {data.stakedCount} of {data.total} staked · {data.totalUsdc.toFixed(2)} USDC
        </div>
      </div>

      <ul className="grid gap-1.5 sm:grid-cols-2">
        {data.votes.map((v) => (
          <li
            key={v.slug}
            className={`flex items-center justify-between gap-2 rounded-lg border px-2.5 py-1.5 ${
              v.staked
                ? "border-pv-emerald/35 bg-pv-emerald/[0.05]"
                : "border-pv-border/30 bg-pv-surface2/20"
            }`}
          >
            <div className="flex min-w-0 items-center gap-2">
              <span className="flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-full border border-pv-ink/[0.1] bg-pv-surface2" aria-hidden>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={openPeepsAvatar(`council-${v.slug}`)}
                  alt=""
                  className="h-full w-full object-cover object-top opacity-90"
                />
              </span>
              <span className={`truncate text-[12px] font-semibold ${v.staked ? "text-pv-text" : "text-pv-muted"}`}>
                {v.displayName}
              </span>
            </div>
            {v.staked && v.txHash ? (
              <div className="flex shrink-0 items-center gap-1.5">
                <span className="font-mono text-[10px] tabular-nums text-pv-emerald">
                  ✓ {v.stakeUsdc.toFixed(2)} USDC
                </span>
                <a
                  href={getExplorerTxUrl(v.txHash)}
                  target="_blank"
                  rel="noreferrer"
                  className="font-mono text-[10px] text-pv-muted hover:text-pv-emerald"
                >
                  tx ↗
                </a>
              </div>
            ) : (
              <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-pv-muted">— abstain</span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
