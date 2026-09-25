"use client";

/**
 * The public agent reasoning timeline for one market (§03).
 *
 * Shows what each agent said, when, on what evidence, and how sure it was — and
 * splits reasoning published BEFORE the agent committed money from reasoning
 * published after, because those are different claims and only the order makes
 * that visible.
 *
 * Three things this component deliberately does not do:
 *
 *  - It never renders hidden chain-of-thought. The API only returns the public
 *    summary, uncertainty and evidence; the premium persona take is sold behind
 *    x402 elsewhere.
 *  - It does not hide unsourced reasoning. An event with no evidence is shown and
 *    counted, because a feed that dropped them would look uniformly well-sourced.
 *  - It does not fail the page. No database, no feed — the section simply does not
 *    render, rather than throwing inside the market detail view.
 */

import { useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";

import {
  buildFeedView,
  confidencePercent,
  type FeedItem,
} from "@/lib/reasoning/feed-view";
import ResearchSourceCitations from "@/components/research/ResearchSourceCitations";

const REFRESH_MS = 30_000;

export default function ReasoningFeed({ claimId }: { claimId: number }) {
  const t = useTranslations("reasoningFeed");
  const [items, setItems] = useState<FeedItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [agentId, setAgentId] = useState<string>("");
  const [track, setTrack] = useState<string>("");
  // Rendered client-side from a server timestamp, so freshness is computed once per
  // load rather than per render — otherwise two rows a millisecond apart disagree.
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  useEffect(() => {
    if (claimId <= 0) return;
    let cancelled = false;

    async function load() {
      try {
        const res = await fetch(`/api/vs/${claimId}/reasoning`, { cache: "no-store" });
        const data = (await res.json()) as { items?: FeedItem[] };
        if (cancelled) return;
        setItems(Array.isArray(data.items) ? data.items : []);
        setNowMs(Date.now());
      } catch {
        // A missing feed is not a broken market page.
        if (!cancelled) setItems([]);
      } finally {
        if (!cancelled) setLoaded(true);
      }
    }

    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [claimId]);

  const view = useMemo(
    () => buildFeedView(items, { agentId: agentId || undefined, track: track || undefined }),
    [items, agentId, track],
  );

  // Nothing to show and nothing to explain: render nothing rather than an empty
  // card on every market that no agent has looked at yet.
  if (!loaded || items.length === 0) return null;

  return (
    <section className="rounded-2xl border border-pv-ink/[0.12] bg-pv-bg/30 p-5 sm:p-6">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-[11px] font-bold uppercase tracking-[0.18em] text-pv-emerald/85">
            {t("title")}
          </h2>
          <p className="mt-2 text-sm leading-relaxed text-pv-muted">{t("hint")}</p>
        </div>

        <div className="flex flex-wrap gap-2">
          {view.agents.length > 1 && (
            <select
              aria-label={t("filterAgent")}
              value={agentId}
              onChange={(event) => setAgentId(event.target.value)}
              className="rounded-lg border border-pv-ink/[0.12] bg-pv-bg/60 px-2 py-1 text-xs text-pv-text"
            >
              <option value="">{t("allAgents")}</option>
              {view.agents.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
          )}
          {view.tracks.length > 1 && (
            <select
              aria-label={t("filterTrack")}
              value={track}
              onChange={(event) => setTrack(event.target.value)}
              className="rounded-lg border border-pv-ink/[0.12] bg-pv-bg/60 px-2 py-1 text-xs text-pv-text"
            >
              <option value="">{t("allTracks")}</option>
              {view.tracks.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>

      {view.groups.length === 0 ? (
        <p className="text-sm text-pv-muted">{t("noneMatchFilter")}</p>
      ) : (
        <div className="space-y-5">
          {view.groups.map((group) => (
            <div key={group.phase}>
              <h3 className="mb-2 text-[10px] font-bold uppercase tracking-[0.16em] text-pv-muted">
                {group.phase === "before" ? t("phaseBefore") : t("phaseAfter")}
              </h3>
              <ol className="space-y-3">
                {group.items.map((entry) => (
                  <li
                    key={entry.eventId}
                    className="rounded-xl border border-pv-ink/[0.1] bg-pv-ink/[0.015] p-3 sm:p-4"
                  >
                    <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] font-bold uppercase tracking-[0.14em] text-pv-muted">
                      <span className="text-pv-text">{entry.agentId}</span>
                      <span>{entry.track}</span>
                      <span>{entry.stage.replace(/_/g, " ")}</span>
                      <span className="tabular-nums">
                        {t("confidence", { percent: confidencePercent(entry.confidenceBps) })}
                      </span>
                      <span>{t(`position_${entry.position}`)}</span>
                    </div>

                    <p className="text-sm leading-relaxed text-pv-text">{entry.summary}</p>

                    {/* Uncertainty is required by the schema and shown next to the
                        claim, not tucked away — a confident-sounding summary with a
                        buried caveat is the failure mode this feed exists to avoid. */}
                    {entry.uncertainty && (
                      <p className="mt-2 text-xs leading-relaxed text-pv-muted">
                        {t("uncertainty")}: {entry.uncertainty}
                      </p>
                    )}

                    {entry.evidence.length > 0 ? (
                      <div className="mt-3">
                        <ResearchSourceCitations
                          sources={entry.evidence.map((ref) => ({
                            url: ref.url,
                            domain: ref.domain,
                            trustTier: ref.trustTier,
                            contentHash: ref.contentHash,
                            capturedAt: ref.capturedAt,
                            freshnessSeconds: ref.freshnessSeconds,
                          }))}
                          nowMs={nowMs}
                        />
                      </div>
                    ) : (
                      <p className="mt-3 text-xs text-amber-200/90">{t("noEvidence")}</p>
                    )}
                  </li>
                ))}
              </ol>
            </div>
          ))}
        </div>
      )}

      {view.withoutEvidence > 0 && (
        <p className="mt-4 text-[11px] leading-relaxed text-pv-muted/80">
          {t("withoutEvidenceNote", { count: view.withoutEvidence })}
        </p>
      )}
    </section>
  );
}
