"use client";

import { useMemo } from "react";
import { useLocale, useTranslations } from "next-intl";
import { ShieldCheck, Scale, ScrollText } from "lucide-react";

import { GlassCard } from "@/components/ui";
import { formatDeadline, normalizeResolutionSource } from "@/lib/constants";
import { computeClaimQuality } from "@/lib/claimQuality";
import type { VSData } from "@/lib/contract";
import SettlementReceipt from "@/components/SettlementReceipt";
import ResearchSourceCitations from "@/components/research/ResearchSourceCitations";

type SettlementExplanationCardProps = {
  vs: VSData;
  className?: string;
};

type ConfidenceTier = "high" | "medium" | "low";

function getConfidenceTier(confidence: number): ConfidenceTier {
  if (confidence >= 80) {
    return "high";
  }
  if (confidence >= 60) {
    return "medium";
  }
  return "low";
}

const confidenceClasses: Record<ConfidenceTier, string> = {
  high: "border-pv-emerald/35 bg-pv-emerald/[0.12] text-pv-emerald",
  medium: "border-pv-cyan/35 bg-pv-cyan/[0.12] text-pv-cyan",
  low: "border-amber-400/35 bg-amber-400/[0.12] text-amber-300",
};

export default function SettlementExplanationCard({
  vs,
  className = "",
}: SettlementExplanationCardProps) {
  const t = useTranslations("settlement");
  const locale = useLocale();

  const normalizedSource = useMemo(
    () => normalizeResolutionSource(vs.resolution_url),
    [vs.resolution_url]
  );

  const sourceHost = useMemo(() => {
    if (!normalizedSource) {
      return t("unknownSource");
    }

    try {
      return new URL(normalizedSource).hostname.replace(/^www\./i, "");
    } catch {
      return normalizedSource;
    }
  }, [normalizedSource, t]);

  const claimQuality = computeClaimQuality({
    question: vs.question,
    creator_position: vs.creator_position,
    opponent_position: vs.opponent_position,
    resolution_url: vs.resolution_url,
    settlement_rule: vs.settlement_rule ?? "",
    category: vs.category,
    deadline: vs.deadline,
  });

  // La "Confidence" de esta card está destinada a ser el score de calidad
  // equivalente al "Claim Strength" (0..100), no `vs.confidence` (on-chain).
  const confidence = claimQuality.score;
  const confidenceTier = getConfidenceTier(confidence);

  const outcomeLabel =
    vs.winner_side === "creator"
      ? t("outcomes.creator")
      : vs.winner_side === "challengers"
        ? t("outcomes.challengers")
        : vs.winner_side === "draw"
          ? t("outcomes.draw")
          : t("outcomes.unresolvable");

  const summary = vs.resolution_summary?.trim() || t("noSummary");
  const settlementRule = vs.settlement_rule?.trim() || t("ruleFallback");
  const deadlineLabel = formatDeadline(vs.deadline ?? 0, locale === "en" ? "en" : "es");

  return (
    <GlassCard
      glass
      glow="none"
      noPad
      className={`!rounded-2xl border border-pv-ink/[0.12] ${className}`}
    >
      <div className="p-5 sm:p-6">
        <div className="space-y-5">
          <div className="flex min-w-0 items-start gap-3 sm:gap-3.5">
            <span
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-pv-emerald/10 text-pv-emerald"
              aria-hidden
            >
              <ScrollText size={14} />
            </span>
            <div className="min-w-0 space-y-1">
              <h3 className="font-display text-xs font-bold uppercase tracking-[0.18em] text-pv-text sm:tracking-[0.2em]">
                {t("title")}
              </h3>
              <p className="text-[10px] leading-relaxed text-pv-muted sm:text-[11px]">
                {t("hint")}
              </p>
            </div>
          </div>

          {(() => {
            // Surface the oracle's actual confidence tier on the verdict.
            // The text on the right is "claim strength" (pre-settlement quality);
            // this pill is the live oracle confidence the contract recorded.
            const oc = typeof vs.confidence === "number" ? vs.confidence : null;
            if (oc === null || vs.winner_side === "" || vs.winner_side === "unresolvable" && oc === 0) return null;
            const tier = oc >= 80 ? "firm" : oc >= 60 ? "contested" : "refund";
            const isContestedTag = (summary ?? "").includes("[CONTESTED]");
            const isRefundTag    = (summary ?? "").includes("[LOW CONFIDENCE");
            const label =
              isRefundTag ? "REFUNDED · low confidence" :
              isContestedTag || tier === "contested" ? "CONTESTED · medium confidence" :
              tier === "firm" ? "FIRM · high confidence" :
              null;
            if (!label) return null;
            const cls =
              isRefundTag ? "border-amber-400/40 bg-amber-400/[0.10] text-amber-700" :
              isContestedTag || tier === "contested" ? "border-pv-border/60 bg-pv-surface2/60 text-pv-text/80" :
              "border-pv-emerald/40 bg-pv-emerald/[0.08] text-pv-emerald";
            return (
              <div className={`mb-2 inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[10px] font-bold uppercase tracking-[0.18em] ${cls}`}>
                <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden />
                {label} · {oc}%
              </div>
            );
          })()}

          <div className="grid gap-4 lg:grid-cols-[1.3fr_1fr]">
            <div className="space-y-4">
              <div className="rounded-xl border border-pv-ink/[0.08] bg-pv-bg/40 p-4">
                <div className="mb-2 flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.16em] text-pv-emerald/80">
                  <Scale size={14} />
                  {t("verdict")}
                </div>
                <div className="text-lg font-semibold text-pv-text">{outcomeLabel}</div>
                <p className="mt-2 text-sm leading-relaxed text-pv-muted">{summary}</p>
              </div>

              <div className="rounded-xl border border-pv-ink/[0.08] bg-pv-bg/40 p-4">
                <div className="mb-2 flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.16em] text-pv-cyan/80">
                  <ScrollText size={14} />
                  {t("ruleApplied")}
                </div>
                <p className="text-sm leading-relaxed text-pv-text/90">{settlementRule}</p>
                {deadlineLabel ? (
                  <p className="mt-2 text-xs leading-relaxed text-pv-muted">
                    <span className="font-bold uppercase tracking-[0.12em] text-pv-muted/80">
                      {t("receiptDeadline")}
                    </span>
                    {": "}
                    <time
                      dateTime={new Date((vs.deadline ?? 0) * 1000).toISOString()}
                      className="font-mono tabular-nums text-pv-text/80"
                    >
                      {deadlineLabel}
                    </time>
                  </p>
                ) : null}
                <p className="mt-2 text-xs leading-relaxed text-pv-muted">
                  {t("consensusHint")}
                </p>
              </div>
            </div>

            <div className="space-y-4">
              <ResearchSourceCitations
                sources={[
                  {
                    url: vs.resolution_url,
                    domain: sourceHost === t("unknownSource") ? undefined : sourceHost,
                    trustTier: "primary",
                    contentHash: (vs as { evidence_hash?: string }).evidence_hash,
                    excerpt: vs.resolution_summary,
                  },
                ]}
                deadlineUnix={typeof vs.deadline === "number" ? vs.deadline : null}
                cancelled={vs.state === "cancelled"}
                title={t("evidence")}
              />

              <div className="rounded-xl border border-pv-ink/[0.08] bg-pv-bg/40 p-4">
                <div className="mb-2 flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.16em] text-pv-gold/80">
                  <ShieldCheck size={14} />
                  {t("confidence")}
                </div>
                <div className="flex items-end justify-between gap-3">
                  <div className="font-display text-3xl font-bold tracking-tight text-pv-text">
                    {confidence}
                  </div>
                  <div className="text-right text-[11px] text-pv-muted">
                    {t("scoreOutOf")}
                  </div>
                </div>

                <div className="mt-3 h-2 overflow-hidden rounded-full bg-pv-ink/[0.08]">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-amber-400 via-pv-cyan to-pv-emerald transition-[width] duration-300"
                    style={{ width: `${Math.max(0, Math.min(100, confidence))}%` }}
                  />
                </div>

                {/* Tier label (minimal, debajo de la progress bar) */}
                <div className="mt-3 border-t border-pv-ink/[0.08] pt-3">
                  <div
                    className={`flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.16em] ${
                      confidenceTier === "high"
                        ? "text-pv-emerald"
                        : confidenceTier === "medium"
                          ? "text-pv-cyan"
                          : "text-amber-300"
                    }`}
                  >
                    <span
                      className={`h-2 w-2 rounded-full ${
                        confidenceTier === "high"
                          ? "bg-pv-emerald"
                          : confidenceTier === "medium"
                            ? "bg-pv-cyan"
                            : "bg-amber-400"
                      }`}
                      aria-hidden
                    />
                    {t(`confidenceTiers.${confidenceTier}`)}
                  </div>
                </div>
              </div>
            </div>
          </div>

          <SettlementReceipt vs={vs} />
        </div>
      </div>
    </GlassCard>
  );
}
