"use client";

import { useMemo } from "react";
import { useTranslations } from "next-intl";
import { ExternalLink, Link2Off, Quote, ShieldCheck } from "lucide-react";

import {
  buildResearchCitations,
  researchCitationsShowsRows,
  type BuildResearchCitationsOptions,
  type ResearchCitationView,
  type ResearchCitationsView,
} from "@/lib/research/citations";

type ResearchSourceCitationsProps = BuildResearchCitationsOptions & {
  className?: string;
  /** Optional heading override; defaults to i18n title. */
  title?: string;
};

const STATUS_CLASSES: Record<ResearchCitationsView["status"], string> = {
  ready: "border-pv-emerald/30 bg-pv-emerald/[0.08] text-pv-emerald",
  empty: "border-pv-border/50 bg-pv-surface2/40 text-pv-muted",
  invalid: "border-pv-border/50 bg-pv-surface2/40 text-pv-muted",
  stale: "border-pv-danger/35 bg-pv-danger/[0.08] text-pv-danger",
  cancelled: "border-amber-400/35 bg-amber-400/[0.10] text-amber-300",
  dependency_failure: "border-amber-400/35 bg-amber-400/[0.10] text-amber-300",
};

const ROW_STATUS_CLASSES: Partial<Record<ResearchCitationView["status"], string>> = {
  stale: "text-pv-danger",
  dependency_failure: "text-amber-300",
  duplicated: "text-pv-muted line-through",
  cancelled: "text-amber-300",
  invalid: "text-pv-muted",
};

function trustLabel(
  tier: ResearchCitationView["trustTier"],
  t: ReturnType<typeof useTranslations<"researchCitations">>,
): string {
  return t(`trust.${tier}`);
}

export default function ResearchSourceCitations({
  sources,
  deadlineUnix = null,
  maxAgeSeconds = null,
  nowMs,
  cancelled = false,
  className = "",
  title,
}: ResearchSourceCitationsProps) {
  const t = useTranslations("researchCitations");

  const view = useMemo(
    () =>
      buildResearchCitations({
        sources,
        deadlineUnix,
        maxAgeSeconds,
        nowMs,
        cancelled,
      }),
    [sources, deadlineUnix, maxAgeSeconds, nowMs, cancelled],
  );

  const showRows = researchCitationsShowsRows(view);

  return (
    <div
      className={`rounded-xl border border-pv-ink/[0.08] bg-pv-bg/40 p-4 ${className}`.trim()}
      data-testid="research-source-citations"
      data-status={view.status}
      aria-live="polite"
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.16em] text-pv-text/80">
          <Quote size={14} aria-hidden />
          {title ?? t("title")}
        </div>
        <span
          className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-[0.14em] ${STATUS_CLASSES[view.status]}`}
        >
          <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden />
          {t(`status.${view.statusMessageKey}`)}
        </span>
      </div>

      <p className="mb-3 text-xs leading-relaxed text-pv-muted">
        {t(`statusHint.${view.statusMessageKey}`)}
      </p>

      {showRows ? (
        <ol className="space-y-3">
          {view.displayable.map((row, index) => (
            <li
              key={row.id}
              className="rounded-lg border border-pv-ink/[0.08] bg-pv-ink/[0.02] px-3 py-2.5"
              data-citation-status={row.status}
            >
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] font-bold uppercase tracking-[0.14em] text-pv-muted">
                <span className="text-pv-text/85">[{index + 1}]</span>
                <span>{trustLabel(row.trustTier, t)}</span>
                {row.status !== "ready" ? (
                  <span className={ROW_STATUS_CLASSES[row.status] ?? ""}>
                    {t(`rowStatus.${row.status}`)}
                  </span>
                ) : null}
              </div>

              <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                {row.externalSafe ? (
                  <a
                    href={row.url}
                    target="_blank"
                    rel="noopener noreferrer nofollow"
                    className="inline-flex min-w-0 items-center gap-1 font-semibold text-pv-cyan hover:text-pv-text transition-colors"
                  >
                    <span className="truncate">{row.domain || row.url}</span>
                    <ExternalLink size={12} aria-hidden />
                  </a>
                ) : (
                  <span className="inline-flex items-center gap-1 text-pv-muted">
                    <Link2Off size={12} aria-hidden />
                    {t("unsafeLink")}
                  </span>
                )}
                {row.shortHash ? (
                  <span className="inline-flex items-center gap-1 font-mono text-[11px] text-pv-muted">
                    <ShieldCheck size={11} aria-hidden />
                    {row.shortHash}
                  </span>
                ) : (
                  <span className="text-[11px] text-amber-200/90">{t("noHash")}</span>
                )}
              </div>

              {row.excerpt ? (
                <p className="mt-2 text-xs leading-relaxed text-pv-muted">
                  <span className="font-semibold text-pv-text/70">{t("excerpt")}: </span>
                  {row.excerpt}
                </p>
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}

      {view.duplicatedDropped > 0 ? (
        <p className="mt-3 text-[11px] leading-relaxed text-pv-muted/80">
          {t("duplicatedNote", { count: view.duplicatedDropped })}
        </p>
      ) : null}

      <p className="mt-3 border-t border-pv-ink/[0.08] pt-3 text-[11px] leading-relaxed text-pv-muted">
        {t("privacyNote")}
      </p>
    </div>
  );
}
