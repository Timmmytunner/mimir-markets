"use client";

import { Link } from "@/i18n/navigation";
import { getVSChallengerCount, isVSJoinable, didUserChallengeVS, type VSData } from "@/lib/contract";
import { computeClaimQuality } from "@/lib/claimQuality";
import { openPeepsAvatar } from "@/lib/avatars";
import { useTranslations } from "next-intl";

type ArenaVS = Pick<
  VSData,
  | "id"
  | "question"
  | "stake_amount"
  | "opponent"
  | "category"
  | "state"
  | "challenger_count"
  | "market_type"
  | "max_challengers"
  | "odds_mode"
> &
  Partial<
    Pick<
      VSData,
      | "creator_position"
      | "opponent_position"
      | "resolution_url"
      | "settlement_rule"
      | "deadline"
    >
  >;

const sampleBadgePillClass =
  "rounded border border-pv-emerald/25 bg-pv-emerald/[0.06] px-2 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-pv-emerald/90";

interface ArenaCardProps {
  vs: ArenaVS;
  challengersCount?: number;
  viewerAddress?: string | null;
  /** Pill label “ARCHIVE” (shorter) instead of “ARCHIVED” for curated / demo cards. */
  archiveLabelShort?: boolean;
  /** Explorer demos: dashed border + ring like legacy VSCard samples. */
  isSample?: boolean;
  sampleBadgeLabel?: string;
  /** When set, category in the subtitle links to this href (e.g. Explore with `?cat=`). */
  categoryFilterHref?: string;
  /** Explorer: hide claim-strength / needs-challengers pills for a cleaner grid. */
  hideQualityPills?: boolean;
  /** e.g. home LIVE ARENA: hide only the claim-strength pill; needs-challengers can still show. */
  hideClaimStrengthPill?: boolean;
}

function formatArenaIdCode(id: number): string {
  const n = Math.abs(id) % 100000;
  const padded = String(n).padStart(4, "0");
  const letter = String.fromCharCode(65 + (Math.abs(id) % 26));
  return `#${padded}-${letter}`;
}

type ArenaStatusKey = "arenaStatusLive" | "arenaStatusPending" | "arenaStatusArchived";

const ARENA_STAT_CELL =
  "rounded border border-pv-ink/[0.1] bg-pv-ink/[0.03] px-3 py-2.5 sm:px-3.5 sm:py-3";

function getArenaPresentation(vs: ArenaVS): {
  statusKey: ArenaStatusKey;
  statusVariant: "live" | "muted" | "archived";
} {
  if (vs.state === "resolved" || vs.state === "cancelled") {
    return { statusKey: "arenaStatusArchived", statusVariant: "archived" };
  }
  if (vs.state === "accepted") {
    return { statusKey: "arenaStatusLive", statusVariant: "live" };
  }
  return { statusKey: "arenaStatusPending", statusVariant: "muted" };
}

export default function ArenaCard({
  vs,
  challengersCount,
  viewerAddress,
  archiveLabelShort = false,
  isSample = false,
  sampleBadgeLabel,
  categoryFilterHref,
  hideQualityPills = false,
  hideClaimStrengthPill = false,
}: ArenaCardProps) {
  const t = useTranslations("home");
  const tCat = useTranslations("categories");
  const tDetail = useTranslations("vsDetail");
  const tQuality = useTranslations("quality");

  const activeChallengers = challengersCount ?? getVSChallengerCount(vs as VSData);
  const marketType = vs.market_type ?? "binary";
  const oddsMode = vs.odds_mode ?? "pool";
  const maxChallengers =
    typeof vs.max_challengers === "number" && vs.max_challengers > 0
      ? vs.max_challengers
      : 1;
  const { statusKey, statusVariant } = getArenaPresentation(vs);
  const isArchived = vs.state === "resolved" || vs.state === "cancelled";
  const statusPillMessageKey =
    isArchived && archiveLabelShort ? "arenaStatusArchive" : statusKey;
  const claimQuality =
    hideQualityPills || hideClaimStrengthPill
    ? null
    : computeClaimQuality({
        question: vs.question,
        creator_position: vs.creator_position ?? "",
        opponent_position: vs.opponent_position ?? "",
        resolution_url: vs.resolution_url ?? "",
        settlement_rule: vs.settlement_rule ?? "",
        category: vs.category,
        deadline: vs.deadline ?? 0,
      });
  const canJoin = isVSJoinable(vs as VSData, viewerAddress ?? undefined);
  const joined = viewerAddress ? didUserChallengeVS(vs as VSData, viewerAddress) : false;
  const showNeedsBadge =
    !hideQualityPills && !isArchived && activeChallengers < 2 && canJoin;

  const statusPillClass =
    statusVariant === "live"
      ? "font-display text-xs font-semibold uppercase tracking-wide text-pv-emerald bg-pv-emerald/10 px-2 py-1"
      : statusVariant === "archived"
        ? "font-display text-xs font-semibold uppercase tracking-wide text-pv-muted bg-pv-ink/[0.06] px-2 py-1 ring-1 ring-pv-ink/[0.08]"
        : "font-display text-xs font-semibold uppercase tracking-wide text-pv-muted bg-pv-ink/[0.06] px-2 py-1 ring-1 ring-pv-ink/[0.08]";

  const marketLabel = tDetail(`marketTypes.${marketType}`);
  const oddsLabel = tDetail(`oddsModes.${oddsMode}`);
  const strengthBadgeClass = claimQuality
    ? claimQuality.tier === "strong"
      ? "border-pv-emerald/35 bg-pv-emerald/[0.12] text-pv-emerald"
      : claimQuality.tier === "good"
        ? "border-pv-cyan/35 bg-pv-cyan/[0.12] text-pv-cyan"
        : claimQuality.tier === "fair"
          ? "border-amber-400/35 bg-amber-400/[0.12] text-amber-300"
          : "border-pv-ink/[0.14] bg-pv-ink/[0.05] text-pv-muted"
    : "";

  const cardState = vs.state ?? "unknown";
  const cardDisabled = cardState === "cancelled";

  return (
    <article
      data-market-card={String(vs.id)}
      data-market-card-state={cardState}
      data-market-card-disabled={cardDisabled ? "true" : undefined}
      className={`card group relative flex h-full flex-col gap-6 overflow-hidden border-pv-ink/[0.12] bg-pv-surface p-6 transition-all duration-300 hover:border-pv-emerald/30 hover:bg-pv-surface2 sm:gap-8 sm:p-8 ${
        isSample
          ? "border border-dashed border-pv-emerald/35 bg-pv-surface/80 ring-1 ring-pv-emerald/[0.12]"
          : ""
      }`}
    >
      <div className="relative z-10 flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {isSample && sampleBadgeLabel ? (
            <span className={`shrink-0 ${sampleBadgePillClass}`}>{sampleBadgeLabel}</span>
          ) : null}
          <span className={statusPillClass}>{t(statusPillMessageKey)}</span>
          {joined ? (
            <span className="font-display text-xs font-semibold uppercase tracking-wide text-pv-emerald bg-pv-emerald/15 px-2 py-1 ring-1 ring-pv-emerald/30">
              {t("arenaJoinedBadge")}
            </span>
          ) : null}
        </div>
        <span className="rounded px-2 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-pv-muted ring-1 ring-pv-ink/[0.1] bg-pv-ink/[0.03] backdrop-blur-sm">
          {t("arenaIdBadge", { code: formatArenaIdCode(vs.id) })}
        </span>
      </div>

      <div className="relative z-10 min-w-0 flex-1">
        <h3 className="line-clamp-2 font-display text-xl font-bold uppercase leading-tight tracking-tight text-pv-text sm:text-2xl">
          {vs.question}
        </h3>
        <div className="mt-3 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-left text-[11px] font-display font-bold uppercase tracking-[0.12em] text-pv-muted sm:text-xs">
              {categoryFilterHref ? (
                <Link
                  href={categoryFilterHref}
                  className="text-pv-muted underline-offset-2 transition-colors hover:text-pv-text hover:underline"
                >
                  {tCat(vs.category)}
                </Link>
              ) : (
                tCat(vs.category)
              )}
            </p>
            {claimQuality ? (
              <span
                className={`inline-flex items-center rounded-full border px-2 py-1 text-[10px] font-bold uppercase tracking-[0.16em] ${strengthBadgeClass}`}
              >
                {tQuality("claimStrength")}: {tQuality(`tiers.${claimQuality.tier}`)}
              </span>
            ) : null}
            {showNeedsBadge ? (
              <span className="inline-flex items-center rounded-full border border-pv-emerald/30 bg-pv-emerald/[0.08] px-2 py-1 text-[10px] font-bold uppercase tracking-[0.16em] text-pv-emerald">
                {tQuality("needsChallengers")}
              </span>
            ) : null}
          </div>
          <div className="grid grid-cols-2 gap-2 sm:gap-2.5">
            <div className={ARENA_STAT_CELL}>
              <span className="block font-mono text-[9px] font-bold uppercase tracking-[0.16em] text-pv-muted">
                {t("arenaStatMinStake")}
              </span>
              <span className="mt-1 block font-display text-sm font-bold uppercase tabular-nums tracking-tight text-pv-text sm:text-[15px]">
                {vs.stake_amount} USDC
              </span>
            </div>
            <div className={ARENA_STAT_CELL}>
              <span className="block font-mono text-[9px] font-bold uppercase tracking-[0.16em] text-pv-muted">
                {t("arenaStatBetType")}
              </span>
              <span className="mt-1 block truncate font-display text-sm font-bold uppercase leading-snug tracking-tight text-pv-text sm:text-[15px]">
                {marketLabel}
              </span>
            </div>
            <div className={ARENA_STAT_CELL}>
              <span className="block font-mono text-[9px] font-bold uppercase tracking-[0.16em] text-pv-muted">
                {t("arenaStatOddsMode")}
              </span>
              <span className="mt-1 block truncate font-display text-sm font-bold uppercase leading-snug tracking-tight text-pv-text sm:text-[15px]">
                {oddsLabel}
              </span>
            </div>
            <div className={ARENA_STAT_CELL}>
              <span className="block font-mono text-[9px] font-bold uppercase tracking-[0.16em] text-pv-muted">
                {t("arenaStatFillStatus")}
              </span>
              <span className="mt-1 block font-display text-sm font-bold uppercase tabular-nums tracking-tight text-pv-emerald sm:text-[15px]">
                {activeChallengers}/{maxChallengers}
              </span>
            </div>
          </div>
        </div>
      </div>

      <div className="relative z-10 mt-auto border-t border-pv-ink/[0.1] pt-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0">
            <span className="mb-2 block font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-pv-muted">
              {t("arenaParticipantsLabel")}
            </span>
            <div className="flex items-center gap-3">
              <div className="flex items-center pl-0.5">
                {[0, 1, 2].map((i) => (
                  <span
                    key={`${vs.id}-avatar-${i}`}
                    className={`flex h-8 w-8 items-center justify-center overflow-hidden rounded-full border border-pv-ink/[0.15] bg-pv-surface2 ${i > 0 ? "-ml-2.5" : ""}`}
                    style={{ zIndex: 10 - i }}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={openPeepsAvatar(`market-${vs.id}-participant-${i}`)}
                      alt=""
                      aria-hidden
                      className="h-full w-full object-cover object-top"
                    />
                  </span>
                ))}
              </div>
              <span className="font-display text-2xl font-bold tabular-nums tracking-tight text-pv-text sm:text-3xl">
                {activeChallengers}
              </span>
            </div>
          </div>

          <Link
            href={`/vs/${vs.id}`}
            data-market-card-focus
            className={
              isArchived || joined
                ? "inline-flex shrink-0 items-center justify-center rounded-md border border-pv-ink/[0.15] bg-transparent px-5 py-2 font-display text-[10px] font-bold uppercase tracking-[0.18em] text-pv-muted shadow-none transition-[color,border-color,transform,box-shadow] duration-200 ease-out hover:-translate-y-px hover:border-pv-ink/[0.28] hover:bg-transparent hover:text-pv-text hover:shadow-[0_4px_18px_-6px_rgba(0,0,0,0.45)] active:translate-y-0 active:scale-[0.98] active:shadow-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pv-ink/20 focus-visible:ring-offset-2 focus-visible:ring-offset-pv-surface"
                : "inline-flex shrink-0 items-center justify-center rounded-md bg-pv-text px-5 py-2 font-display text-[10px] font-bold uppercase tracking-[0.18em] text-pv-bg shadow-none transition-[transform,box-shadow,background-color,border-color,color] duration-200 ease-out hover:-translate-y-px hover:bg-pv-emerald hover:text-pv-bg hover:shadow-[0_6px_18px_-4px_rgba(51,79,169,0.35)] active:translate-y-0 active:scale-[0.98] active:shadow-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pv-emerald/40 focus-visible:ring-offset-2 focus-visible:ring-offset-pv-surface"
            }
          >
            {isArchived ? t("arenaViewDetails") : joined ? t("arenaViewDetails") : t("arenaJoin")}
          </Link>
        </div>
      </div>
    </article>
  );
}
