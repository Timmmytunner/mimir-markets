"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { ChevronDown, CirclePlus, Compass } from "lucide-react";
import {
  DASHBOARD_STAKE_HOLDING_IDS,
  DASHBOARD_STAKE_HOLDING_META,
  dashboardStakeHoldingDetailHref,
  getDashboardHoldingFooterPoolPill,
  type DashboardStakeHoldingId,
} from "@/lib/dashboardStakeHoldingsMock";
import {
  DASHBOARD_EXPOSURE_LOAD_MORE,
  DASHBOARD_EXPOSURE_PAGE_SIZE,
  summarizeDashboardFilteredExposure,
  type DashboardFilteredExposureSummary,
} from "@/lib/dashboardUiPolicy";
import {
  type VSData,
  didUserLoseVS,
  didUserWinVS,
  getVSChallengerCount,
  getVSUserWinAmount,
  getVSTotalPot,
  hasVSWinner,
  isVSPrivate,
} from "@/lib/contract";
import { isSampleVsIdForXmtp } from "@/lib/xmtp/vs-chat-eligibility";
import {
  DASHBOARD_CARD_SURFACE,
  DASHBOARD_PANEL_SURFACE,
  DASHBOARD_SKELETON_ROW,
  DASHBOARD_STAT_CELL_SURFACE,
  DASHBOARD_SURFACE_DASHED,
  DASHBOARD_SURFACE_MUTED,
} from "@/lib/dashboardSurface";

const ease = [0.25, 0.1, 0.25, 1] as const;

type RiskProfileKey = "conservative" | "moderate" | "aggressive";

function clamp01(n: number) {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function toRiskProfilePct(wins: number, losses: number): Array<{ key: RiskProfileKey; pct: number }> {
  const safeWins = Number.isFinite(wins) && wins > 0 ? wins : 0;
  const safeLosses = Number.isFinite(losses) && losses > 0 ? losses : 0;
  const total = safeWins + safeLosses;

  // Start at 0% across the board until the user has results.
  if (total <= 0) {
    return [
      { key: "conservative", pct: 0 },
      { key: "moderate", pct: 0 },
      { key: "aggressive", pct: 0 },
    ];
  }

  const wr = clamp01(safeWins / total); // 0..1

  // Map win-rate to a stable 3-bucket distribution that always sums to 100.
  // - conservative rises as wr -> 1
  // - aggressive rises as wr -> 0
  // - moderate peaks around wr ~= 0.5
  const conservativeRaw = clamp01((wr - 0.4) / 0.6);
  const aggressiveRaw = clamp01((0.6 - wr) / 0.6);
  const moderateRaw = clamp01(1 - Math.abs(wr - 0.5) * 2);

  const sum = conservativeRaw + moderateRaw + aggressiveRaw;
  const norm = sum > 0 ? 1 / sum : 0;

  const raw = [
    { key: "conservative" as const, v: conservativeRaw * norm },
    { key: "moderate" as const, v: moderateRaw * norm },
    { key: "aggressive" as const, v: aggressiveRaw * norm },
  ];

  // Round and force sum == 100 (fix rounding drift by adjusting the max bucket).
  const rounded = raw.map((r) => ({ key: r.key, pct: Math.round(r.v * 100) }));
  const roundedSum = rounded.reduce((acc, r) => acc + r.pct, 0);
  const drift = 100 - roundedSum;

  if (drift !== 0) {
    let bestIdx = 0;
    for (let i = 1; i < raw.length; i += 1) {
      if (raw[i].v > raw[bestIdx].v) bestIdx = i;
    }
    rounded[bestIdx] = {
      ...rounded[bestIdx],
      pct: Math.max(0, Math.min(100, rounded[bestIdx].pct + drift)),
    };
  }

  return rounded;
}

/** Campos traducidos usados para la búsqueda (misma `q` que el filtro VS del dashboard). */
const HOLDING_SEARCH_FIELDS = [
  "title",
  "meta",
  "bodyLead",
  "body",
  "stake",
  "winEstimate",
  "returnMultiple",
] as const;

function holdingMatchesDashboardSearch(
  id: DashboardStakeHoldingId,
  rawQuery: string,
  t: (key: string) => string
): boolean {
  const q = rawQuery.trim().toLowerCase();
  if (!q) return true;
  const meta = DASHBOARD_STAKE_HOLDING_META[id];
  const parts = [
    id,
    meta.visibility,
    String(meta.participantCount),
    meta.maxParticipants != null ? String(meta.maxParticipants) : "",
    t(`holdings.status.${meta.status}` as never),
    ...HOLDING_SEARCH_FIELDS.map((field) =>
      t(`holdings.items.${id}.${field}` as never)
    ),
    t("holdings.visibilityPublic"),
    t("holdings.visibilityPrivate"),
    t("holdings.poolPill.closed"),
  ];
  return parts.some((p) => p.toLowerCase().includes(q));
}

/** Mismo trazo que `public/icons/verify.svg`, con `currentColor` para `text-pv-emerald`. */
function StakeHoldingVerifyIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden
    >
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M20.5615 9.21958L22.4215 11.3396C22.7515 11.7196 22.7515 12.2796 22.4115 12.6396L20.5515 14.7596L20.8115 17.5696C20.8615 18.0696 20.5315 18.5296 20.0415 18.6396L17.2815 19.2696L15.8415 21.6996C15.5915 22.1296 15.0515 22.3096 14.5915 22.1096L12.0015 20.9996L9.41148 22.1296C8.94148 22.3296 8.41148 22.1496 8.15148 21.7196L6.71148 19.2996L3.95148 18.6696C3.47148 18.5596 3.13148 18.0996 3.18148 17.5996L3.44148 14.7796L1.58148 12.6596C1.25148 12.2796 1.25148 11.7196 1.58148 11.3396L3.44148 9.20958L3.18148 6.40958C3.13148 5.89958 3.47148 5.44958 3.96148 5.33958L6.71148 4.71958L8.16148 2.29958C8.41148 1.86958 8.95148 1.68958 9.41148 1.88958L12.0015 2.99958L14.6015 1.86958C15.0615 1.66958 15.5915 1.84958 15.8515 2.27958L17.2915 4.70958L20.0515 5.33958C20.5315 5.44958 20.8715 5.90958 20.8215 6.40958L20.5615 9.21958ZM7.5 12.6196L10.09 15.2096C10.48 15.5996 11.12 15.5996 11.5 15.2096L16.5 10.7096C16.89 10.3196 16.89 9.59958 16.5 9.20958C16.11 8.81958 15.39 8.81958 15 9.20958L10.8 13.0896L8.91 11.2096C8.52 10.8196 7.89 10.8196 7.5 11.2096C7.11 11.5996 7.11 12.2296 7.5 12.6196Z"
        fill="currentColor"
      />
    </svg>
  );
}

function StakeHoldingRow({
  id,
  isOpen,
  onToggle,
}: {
  id: DashboardStakeHoldingId;
  isOpen: boolean;
  onToggle: () => void;
}) {
  const t = useTranslations("dashboard");
  const tCat = useTranslations("categories");
  const tDetail = useTranslations("vsDetail");
  const base = `holdings.items.${id}` as const;
  const panelId = `holding-panel-${id}`;
  const buttonId = `holding-trigger-${id}`;
  const detailHref = dashboardStakeHoldingDetailHref[id];
  const meta = DASHBOARD_STAKE_HOLDING_META[id];
  const marketLabel = tDetail(`marketTypes.${meta.marketType}` as never);
  const oddsLabel = tDetail(`oddsModes.${meta.oddsMode}` as never);
  const footerPoolPill = getDashboardHoldingFooterPoolPill(meta);
  const participantsLine =
    meta.visibility === "private" && meta.maxParticipants != null
      ? t("holdings.footerParticipantsCapped", {
          current: meta.participantCount,
          max: meta.maxParticipants,
        })
      : t("holdings.footerParticipants", { count: meta.participantCount });
  const visibilityLine =
    meta.visibility === "private"
      ? t("holdings.visibilityPrivate")
      : t("holdings.visibilityPublic");

  return (
    <div className={DASHBOARD_CARD_SURFACE}>
      <div className="flex items-stretch gap-3 px-3 sm:gap-4 sm:px-4">
        <div className="flex shrink-0 items-center justify-center self-center py-3 sm:py-4">
          <StakeHoldingVerifyIcon className="h-9 w-9 text-pv-emerald sm:h-10 sm:w-10" />
        </div>
        <button
          id={buttonId}
          type="button"
          aria-expanded={isOpen}
          aria-controls={panelId}
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-center justify-between gap-3 py-3 pr-3 text-left sm:py-4 sm:pr-4"
        >
          <div className="min-w-0 flex-1">
            <h3 className="font-display text-[13px] font-bold uppercase leading-snug tracking-tight text-pv-text sm:text-sm">
              {t(`${base}.title` as never)}
            </h3>
            <p className="mt-1 font-mono text-[10px] font-medium uppercase tracking-[0.12em] text-pv-muted sm:text-[11px]">
              {t(`${base}.meta` as never)}
            </p>
          </div>
          <span
            className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-pv-ink/[0.08] bg-pv-ink/[0.04] text-pv-muted transition-[transform,color,border-color] duration-300 ${
              isOpen ? "text-pv-emerald border-pv-emerald/25" : ""
            }`}
          >
            <ChevronDown
              size={18}
              className={`transition-transform duration-300 ${isOpen ? "-rotate-180" : ""}`}
              aria-hidden
            />
          </span>
        </button>
      </div>

      <AnimatePresence initial={false}>
        {isOpen ? (
          <motion.div
            id={panelId}
            role="region"
            aria-labelledby={buttonId}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.28, ease }}
            className="overflow-hidden border-t border-pv-ink/[0.08]"
          >
            <div className="space-y-4 px-3 pb-4 pt-3 sm:space-y-5 sm:px-4 sm:pb-5 sm:pt-4">
              <div
                className="flex flex-wrap items-center gap-2"
                role="group"
                aria-label={t("holdings.chipsGroupAria")}
              >
                <span className="inline-flex shrink-0 items-center rounded-md border border-pv-ink/[0.1] bg-pv-ink/[0.03] px-2 py-1 font-display text-[10px] font-bold uppercase tracking-[0.12em] text-pv-text">
                  {tCat(meta.categoryId)}
                </span>
                <span className="inline-flex min-w-0 items-center rounded-md bg-pv-ink/[0.03] px-2 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-pv-muted ring-1 ring-pv-ink/[0.1]">
                  {meta.idCode}
                </span>
              </div>

              <div className="flex flex-col gap-2 border-b border-pv-ink/[0.06] pb-4 sm:flex-row sm:flex-wrap sm:items-baseline sm:gap-x-6 sm:gap-y-1">
                <p className="min-w-0 flex-1 sm:max-w-[14rem]">
                  <span className="block font-mono text-[9px] font-bold uppercase tracking-[0.16em] text-pv-muted">
                    {t("holdings.marketTypeShort")}
                  </span>
                  <span className="mt-0.5 block font-display text-xs font-bold uppercase leading-snug tracking-tight text-pv-text sm:text-[13px]">
                    {marketLabel}
                  </span>
                </p>
                <p className="min-w-0 flex-1 sm:max-w-[14rem]">
                  <span className="block font-mono text-[9px] font-bold uppercase tracking-[0.16em] text-pv-muted">
                    {t("holdings.oddsModeShort")}
                  </span>
                  <span className="mt-0.5 block font-display text-xs font-bold uppercase leading-snug tracking-tight text-pv-text sm:text-[13px]">
                    {oddsLabel}
                  </span>
                </p>
              </div>

              <div className="space-y-2 text-left">
                <p className="text-sm font-semibold leading-snug text-pv-text sm:text-[15px] sm:leading-relaxed">
                  {t(`${base}.bodyLead` as never)}
                </p>
                <p className="text-xs leading-relaxed text-pv-muted sm:text-[13px]">
                  {t(`${base}.body` as never)}
                </p>
              </div>

              <div>
                <p className="mb-2 font-display text-[10px] font-bold uppercase tracking-[0.2em] text-pv-muted sm:mb-3 sm:text-[11px] sm:tracking-[0.22em]">
                  {t("holdings.positionSummaryLabel")}
                </p>
                <div className="grid w-full max-w-xl grid-cols-1 gap-2 sm:max-w-2xl sm:grid-cols-3 sm:gap-2.5">
                  <div className={DASHBOARD_STAT_CELL_SURFACE}>
                    <span className="block font-mono text-[9px] font-bold uppercase tracking-[0.16em] text-pv-muted">
                      {t("holdings.yourStake")}
                    </span>
                    <span className="mt-1 block font-mono text-sm font-bold tabular-nums text-pv-text sm:text-base">
                      {t(`${base}.stake` as never)}
                    </span>
                  </div>
                  <div
                    className={`${DASHBOARD_STAT_CELL_SURFACE} border-pv-emerald/20 bg-pv-emerald/[0.06]`}
                  >
                    <span className="block font-mono text-[9px] font-bold uppercase tracking-[0.16em] text-pv-muted">
                      {t("holdings.winEstimate")}
                    </span>
                    <span className="mt-1 block font-mono text-sm font-bold tabular-nums text-pv-emerald sm:text-base">
                      {t(`${base}.winEstimate` as never)}
                    </span>
                  </div>
                  <div className={DASHBOARD_STAT_CELL_SURFACE}>
                    <span className="block font-mono text-[9px] font-bold uppercase tracking-[0.16em] text-pv-muted">
                      {t("holdings.returnMultiple")}
                    </span>
                    <span className="mt-1 block font-mono text-sm font-bold tabular-nums text-pv-text sm:text-base">
                      {t(`${base}.returnMultiple` as never)}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      <div className="flex flex-col gap-3 border-t border-pv-ink/[0.06] px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4 sm:px-4 sm:py-3">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-2 sm:gap-x-4">
          {footerPoolPill === "live" ? (
            <span className="inline-flex items-center gap-1.5 rounded border border-pv-emerald/25 bg-pv-emerald/[0.08] px-2 py-0.5 font-display text-[9px] font-bold uppercase tracking-[0.14em] text-pv-emerald sm:text-[10px]">
              <span
                className="relative flex h-2 w-2 shrink-0"
                aria-hidden
              >
                <span className="motion-safe:animate-ping absolute inline-flex h-full w-full rounded-full bg-pv-emerald/50 opacity-60" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-pv-emerald" />
              </span>
              {t("holdings.status.accepted")}
            </span>
          ) : footerPoolPill === "open" ? (
            <span className="inline-flex items-center rounded border border-pv-ink/[0.12] bg-pv-ink/[0.04] px-2 py-0.5 font-display text-[9px] font-bold uppercase tracking-[0.14em] text-pv-muted sm:text-[10px]">
              {t("holdings.status.open")}
            </span>
          ) : footerPoolPill === "closed" ? (
            <span className="inline-flex items-center rounded border border-pv-gold/30 bg-pv-gold/[0.08] px-2 py-0.5 font-display text-[9px] font-bold uppercase tracking-[0.14em] text-pv-gold sm:text-[10px]">
              {t("holdings.poolPill.closed")}
            </span>
          ) : (
            <span className="inline-flex items-center rounded border border-pv-ink/[0.1] bg-pv-ink/[0.04] px-2 py-0.5 font-display text-[9px] font-bold uppercase tracking-[0.14em] text-pv-muted sm:text-[10px]">
              {t("holdings.status.resolved")}
            </span>
          )}
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 sm:gap-x-4">
            <span className="font-mono text-[10px] font-semibold tabular-nums text-pv-text sm:text-[11px]">
              {participantsLine}
            </span>
            <span className="inline-flex items-center rounded border border-pv-ink/[0.1] bg-pv-ink/[0.03] px-2 py-0.5 font-display text-[9px] font-bold uppercase tracking-[0.14em] text-pv-text sm:text-[10px]">
              {visibilityLine}
            </span>
            <span className="inline-flex items-center rounded border border-pv-ink/[0.14] bg-pv-ink/[0.04] px-2 py-0.5 font-display text-[9px] font-bold uppercase tracking-[0.14em] text-pv-muted sm:text-[10px]">
              {t("holdings.demoBadge")}
            </span>
          </div>
        </div>
        <Link
          href={detailHref}
          className="shrink-0 self-end font-display text-[10px] font-bold uppercase tracking-[0.18em] text-pv-emerald transition-colors hover:text-pv-emerald/90 focus-visible:rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pv-emerald/40 focus-visible:ring-offset-2 focus-visible:ring-offset-pv-surface sm:self-auto sm:text-[11px]"
        >
          {t("holdings.viewDetails")}
        </Link>
      </div>
    </div>
  );
}

function vsRowInsetPresenceClass(
  vs: VSData,
  viewerAddress?: string | null
): string {
  if (vs.state === "cancelled") {
    return "shadow-[inset_3px_0_0_0_rgba(255,255,255,0.2)]";
  }
  if (vs.state !== "resolved" || !viewerAddress) return "";
  if (didUserWinVS(vs, viewerAddress)) {
    return "shadow-[inset_3px_0_0_0_rgba(51,79,169,0.72)]";
  }
  if (didUserLoseVS(vs, viewerAddress)) {
    return "shadow-[inset_3px_0_0_0_rgba(248,113,113,0.52)]";
  }
  if (!hasVSWinner(vs)) {
    return "shadow-[inset_3px_0_0_0_rgba(251,191,36,0.45)]";
  }
  return "";
}

function SettlementTeaser({
  vs,
  viewerAddress,
  detailHref,
}: {
  vs: VSData;
  viewerAddress?: string | null;
  detailHref: string;
}) {
  const t = useTranslations("dashboard");
  const linkClass =
    "mt-2 inline-flex font-display text-[10px] font-bold uppercase tracking-[0.16em] text-pv-emerald transition-colors hover:text-pv-emerald/90 focus-visible:rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pv-emerald/40 focus-visible:ring-offset-2 focus-visible:ring-offset-pv-surface sm:text-[11px]";

  if (vs.state === "cancelled") {
    return (
      <div className="rounded-md border border-pv-ink/[0.08] bg-pv-ink/[0.04] px-3 py-2.5 sm:px-4 sm:py-3">
        <p className="font-mono text-[10px] leading-relaxed text-pv-muted sm:text-[11px]">
          {t("holdings.settlementTeaserCancelled")}
        </p>
        <Link href={detailHref} className={linkClass}>
          {t("holdings.settlementDetailsCta")}
        </Link>
      </div>
    );
  }

  if (vs.state !== "resolved" || !viewerAddress) {
    return null;
  }

  if (didUserWinVS(vs, viewerAddress)) {
    const amount = getVSUserWinAmount(vs, viewerAddress);
    return (
      <div className="rounded-md border border-pv-emerald/25 bg-pv-emerald/[0.06] px-3 py-2.5 sm:px-4 sm:py-3">
        <p className="font-mono text-[10px] leading-relaxed text-pv-text sm:text-[11px]">
          {t("holdings.settlementTeaserWon", { amount: String(amount) })}
        </p>
        <Link href={detailHref} className={linkClass}>
          {t("holdings.settlementDetailsCta")}
        </Link>
      </div>
    );
  }

  if (didUserLoseVS(vs, viewerAddress)) {
    return (
      <div className="rounded-md border border-red-400/20 bg-red-400/[0.06] px-3 py-2.5 sm:px-4 sm:py-3">
        <p className="font-mono text-[10px] leading-relaxed text-pv-muted sm:text-[11px]">
          {t("holdings.settlementTeaserLost")}
        </p>
        <Link href={detailHref} className={linkClass}>
          {t("holdings.settlementDetailsCta")}
        </Link>
      </div>
    );
  }

  if (!hasVSWinner(vs)) {
    return (
      <div className="rounded-md border border-amber-400/25 bg-amber-400/[0.06] px-3 py-2.5 sm:px-4 sm:py-3">
        <p className="font-mono text-[10px] leading-relaxed text-pv-muted sm:text-[11px]">
          {t("holdings.settlementTeaserNoVerdict")}
        </p>
        <Link href={detailHref} className={linkClass}>
          {t("holdings.settlementDetailsCta")}
        </Link>
      </div>
    );
  }

  return null;
}

function StakeHoldingVSRow({
  vs,
  isOpen,
  onToggle,
  viewerAddress,
}: {
  vs: VSData;
  isOpen: boolean;
  onToggle: () => void;
  viewerAddress?: string | null;
}) {
  const reduceMotion = useReducedMotion();
  const t = useTranslations("dashboard");
  const tCat = useTranslations("categories");
  const tDetail = useTranslations("vsDetail");

  const marketLabel = vs.market_type
    ? tDetail(`marketTypes.${vs.market_type}` as never)
    : "";
  const oddsLabel = vs.odds_mode
    ? tDetail(`oddsModes.${vs.odds_mode}` as never)
    : "";

  const createdAtDate =
    typeof vs.deadline === "number" && vs.deadline > 0
      ? new Date(vs.deadline * 1000)
      : null;
  const dateStamp = createdAtDate
    ? new Intl.DateTimeFormat(undefined, {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        timeZoneName: "short",
      }).format(createdAtDate)
    : "";
  const timeStamp = createdAtDate
    ? new Intl.DateTimeFormat(undefined, {
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
        timeZoneName: "short",
      }).format(createdAtDate)
    : "";
  // Prefer a single local-timezone stamp (date + time + short TZ) when both
  // formatters overlap on the zone name; fall back to concatenated parts.
  const localDeadlineStamp = createdAtDate
    ? new Intl.DateTimeFormat(undefined, {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
        timeZoneName: "short",
      }).format(createdAtDate)
    : "";
  const metaLine = createdAtDate
    ? `${tCat(vs.category as never)} — ${localDeadlineStamp || `${dateStamp} ${timeStamp}`}`
    : tCat(vs.category as never);

  const participantCount = 1 + getVSChallengerCount(vs);
  const isPrivate = isVSPrivate(vs);

  const idLabel = `#${vs.id}`;
  const titleLine = vs.question?.trim()
    ? vs.question
    : isPrivate
      ? t("holdings.vsTitlePrivate", { id: idLabel })
      : t("holdings.vsTitleOpen", { id: idLabel });

  const footerStatusLabel =
    vs.state === "cancelled"
      ? t("holdings.status.cancelled")
      : vs.state === "accepted"
        ? t("holdings.status.accepted")
        : vs.state === "open"
          ? t("holdings.status.open")
          : t("holdings.status.resolved");

  let outcomeBadge: ReactNode = null;
  if (vs.state === "cancelled") {
    outcomeBadge = (
      <span className="inline-flex items-center rounded border border-pv-ink/[0.18] bg-pv-ink/[0.05] px-2 py-0.5 font-display text-[9px] font-bold uppercase tracking-[0.14em] text-pv-muted sm:text-[10px]">
        {t("holdings.outcomeCancelled")}
      </span>
    );
  } else if (vs.state === "resolved" && viewerAddress) {
    if (didUserWinVS(vs, viewerAddress)) {
      outcomeBadge = (
        <span className="inline-flex items-center rounded border border-pv-emerald/35 bg-pv-emerald/10 px-2 py-0.5 font-display text-[9px] font-bold uppercase tracking-[0.14em] text-pv-emerald sm:text-[10px]">
          {t("holdings.outcomeWon")}
        </span>
      );
    } else if (didUserLoseVS(vs, viewerAddress)) {
      outcomeBadge = (
        <span className="inline-flex items-center rounded border border-red-400/35 bg-red-400/10 px-2 py-0.5 font-display text-[9px] font-bold uppercase tracking-[0.14em] text-red-300 sm:text-[10px]">
          {t("holdings.outcomeLost")}
        </span>
      );
    } else if (!hasVSWinner(vs)) {
      outcomeBadge = (
        <span className="inline-flex items-center rounded border border-amber-400/35 bg-amber-400/10 px-2 py-0.5 font-display text-[9px] font-bold uppercase tracking-[0.14em] text-amber-200/90 sm:text-[10px]">
          {t("holdings.outcomeSettledNeutral")}
        </span>
      );
    }
  }

  const verifyIconClass =
    vs.state === "cancelled"
      ? "h-9 w-9 text-pv-muted sm:h-10 sm:w-10"
      : vs.state === "resolved" && viewerAddress && didUserLoseVS(vs, viewerAddress)
        ? "h-9 w-9 text-red-400/75 sm:h-10 sm:w-10"
        : "h-9 w-9 text-pv-emerald sm:h-10 sm:w-10";

  const maxChallengers =
    typeof vs.max_challengers === "number" && vs.max_challengers > 0
      ? vs.max_challengers
      : null;
  const maxParticipants = maxChallengers != null ? 1 + maxChallengers : null;
  const participantsLine =
    isPrivate && maxParticipants != null
      ? t("holdings.footerParticipantsCapped", {
          current: participantCount,
          max: maxParticipants,
        })
      : t("holdings.footerParticipants", { count: participantCount });

  const visibilityLine = isPrivate
    ? t("holdings.visibilityPrivate")
    : t("holdings.visibilityPublic");

  const userStake =
    typeof vs.creator_stake === "number" && vs.creator_stake > 0
      ? vs.creator_stake
      : vs.stake_amount;
  const totalPot = getVSTotalPot(vs);
  const winEstimate = totalPot;
  const returnMultiple =
    userStake > 0 ? Math.round((winEstimate / userStake) * 100) / 100 : 0;

  const stakeDisplay = `${userStake} USDC`;
  const winEstimateDisplay = `${winEstimate} USDC`;
  const returnMultipleDisplay =
    returnMultiple > 0 ? `${returnMultiple.toFixed(2)}×` : "—";

  const panelId = `holding-vs-panel-${vs.id}`;
  const buttonId = `holding-vs-trigger-${vs.id}`;
  const detailHref = `/vs/${vs.id}`;

  return (
    <div
      className={`${DASHBOARD_CARD_SURFACE} ${vsRowInsetPresenceClass(vs, viewerAddress)}`}
    >
      <div className="flex items-stretch gap-3 px-3 sm:gap-4 sm:px-4">
        <div className="flex shrink-0 items-center justify-center self-center py-3 sm:py-4">
          <StakeHoldingVerifyIcon className={verifyIconClass} />
        </div>
        <button
          id={buttonId}
          type="button"
          aria-expanded={isOpen}
          aria-controls={panelId}
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-center justify-between gap-3 py-3 pr-3 text-left sm:py-4 sm:pr-4"
        >
          <div className="min-w-0 flex-1">
            <h3 className="font-display text-[13px] font-bold uppercase leading-snug tracking-tight text-pv-text sm:text-sm">
              {titleLine}
            </h3>
            <p className="mt-1 font-mono text-[10px] font-medium uppercase tracking-[0.12em] text-pv-muted sm:text-[11px]">
              {metaLine}
            </p>
          </div>
          <span
            className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-pv-ink/[0.08] bg-pv-ink/[0.04] text-pv-muted transition-[transform,color,border-color] duration-300 ${
              isOpen ? "text-pv-emerald border-pv-emerald/25" : ""
            }`}
          >
            <ChevronDown
              size={18}
              className={`transition-transform duration-300 ${
                isOpen ? "-rotate-180" : ""
              }`}
              aria-hidden
            />
          </span>
        </button>
      </div>

      <AnimatePresence initial={false}>
        {isOpen ? (
          <motion.div
            id={panelId}
            role="region"
            aria-labelledby={buttonId}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: reduceMotion ? 0 : 0.28, ease }}
            className="overflow-hidden border-t border-pv-ink/[0.08]"
          >
            <div className="space-y-4 px-3 pb-4 pt-3 sm:space-y-5 sm:px-4 sm:pb-5 sm:pt-4">
              <div
                className="flex flex-wrap items-center gap-2"
                role="group"
                aria-label={t("holdings.chipsGroupAria")}
              >
                <span className="inline-flex shrink-0 items-center rounded-md border border-pv-ink/[0.1] bg-pv-ink/[0.03] px-2 py-1 font-display text-[10px] font-bold uppercase tracking-[0.12em] text-pv-text">
                  {tCat(vs.category as never)}
                </span>
                <span className="inline-flex min-w-0 items-center rounded-md bg-pv-ink/[0.03] px-2 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-pv-muted ring-1 ring-pv-ink/[0.1]">
                  ID #{vs.id}
                </span>
              </div>

              {vs.state === "cancelled" || vs.state === "resolved" ? (
                <SettlementTeaser
                  vs={vs}
                  viewerAddress={viewerAddress}
                  detailHref={detailHref}
                />
              ) : null}

              <div className="flex flex-col gap-2 border-b border-pv-ink/[0.06] pb-4 sm:flex-row sm:flex-wrap sm:items-baseline sm:gap-x-6 sm:gap-y-1">
                <p className="min-w-0 flex-1 sm:max-w-[14rem]">
                  <span className="block font-mono text-[9px] font-bold uppercase tracking-[0.16em] text-pv-muted">
                    {t("holdings.marketTypeShort")}
                  </span>
                  <span className="mt-0.5 block font-display text-xs font-bold uppercase leading-snug tracking-tight text-pv-text sm:text-[13px]">
                    {marketLabel}
                  </span>
                </p>
                <p className="min-w-0 flex-1 sm:max-w-[14rem]">
                  <span className="block font-mono text-[9px] font-bold uppercase tracking-[0.16em] text-pv-muted">
                    {t("holdings.oddsModeShort")}
                  </span>
                  <span className="mt-0.5 block font-display text-xs font-bold uppercase leading-snug tracking-tight text-pv-text sm:text-[13px]">
                    {oddsLabel}
                  </span>
                </p>
              </div>

              <div className="space-y-2 text-left">
                <p className="text-sm font-semibold leading-snug text-pv-text sm:text-[15px] sm:leading-relaxed">
                  {vs.creator_position}
                </p>
                <p className="text-xs leading-relaxed text-pv-muted sm:text-[13px]">
                  {vs.opponent_position}
                </p>
              </div>

              <div>
                <p className="mb-2 font-display text-[10px] font-bold uppercase tracking-[0.2em] text-pv-muted sm:mb-3 sm:text-[11px] sm:tracking-[0.22em]">
                  {t("holdings.positionSummaryLabel")}
                </p>
                <div className="grid w-full max-w-xl grid-cols-1 gap-2 sm:max-w-2xl sm:grid-cols-3 sm:gap-2.5">
                  <div className={DASHBOARD_STAT_CELL_SURFACE}>
                    <span className="block font-mono text-[9px] font-bold uppercase tracking-[0.16em] text-pv-muted">
                      {t("holdings.yourStake")}
                    </span>
                    <span className="mt-1 block font-mono text-sm font-bold tabular-nums text-pv-text sm:text-base">
                      {stakeDisplay}
                    </span>
                  </div>
                  <div
                    className={`${DASHBOARD_STAT_CELL_SURFACE} border-pv-emerald/20 bg-pv-emerald/[0.06]`}
                  >
                    <span className="block font-mono text-[9px] font-bold uppercase tracking-[0.16em] text-pv-muted">
                      {t("holdings.winEstimate")}
                    </span>
                    <span className="mt-1 block font-mono text-sm font-bold tabular-nums text-pv-emerald sm:text-base">
                      {winEstimateDisplay}
                    </span>
                  </div>
                  <div className={DASHBOARD_STAT_CELL_SURFACE}>
                    <span className="block font-mono text-[9px] font-bold uppercase tracking-[0.16em] text-pv-muted">
                      {t("holdings.returnMultiple")}
                    </span>
                    <span className="mt-1 block font-mono text-sm font-bold tabular-nums text-pv-text sm:text-base">
                      {returnMultipleDisplay}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      <div className="flex flex-col gap-3 border-t border-pv-ink/[0.06] px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4 sm:px-4 sm:py-3">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-2 sm:gap-x-4">
          <span className="inline-flex items-center rounded border border-pv-ink/[0.12] bg-pv-ink/[0.04] px-2 py-0.5 font-display text-[9px] font-bold uppercase tracking-[0.14em] text-pv-muted sm:text-[10px]">
            {footerStatusLabel}
          </span>
          {outcomeBadge}
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 sm:gap-x-4">
            <span className="font-mono text-[10px] font-semibold tabular-nums text-pv-text sm:text-[11px]">
              {participantsLine}
            </span>
            <span className="inline-flex items-center rounded border border-pv-ink/[0.1] bg-pv-ink/[0.03] px-2 py-0.5 font-display text-[9px] font-bold uppercase tracking-[0.14em] text-pv-text sm:text-[10px]">
              {visibilityLine}
            </span>
            {isSampleVsIdForXmtp(vs.id) ? (
              <span className="inline-flex items-center rounded border border-pv-ink/[0.14] bg-pv-ink/[0.04] px-2 py-0.5 font-display text-[9px] font-bold uppercase tracking-[0.14em] text-pv-muted sm:text-[10px]">
                {t("holdings.demoVsBadge")}
              </span>
            ) : null}
          </div>
        </div>
        <Link
          href={detailHref}
          className="shrink-0 self-start font-display text-[10px] font-bold uppercase tracking-[0.18em] text-pv-emerald transition-colors hover:text-pv-emerald/90 focus-visible:rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pv-emerald/40 focus-visible:ring-offset-2 focus-visible:ring-offset-pv-surface sm:self-auto sm:text-[11px]"
        >
          {t("holdings.viewDetails")}
        </Link>
      </div>
    </div>
  );
}

type StakeHoldingOpenKey = `mock:${DashboardStakeHoldingId}` | `vs:${number}`;

function ExposureListSkeleton({ count }: { count: number }) {
  return (
    <>
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className={`h-[4.5rem] animate-pulse ${DASHBOARD_SKELETON_ROW} motion-reduce:animate-none motion-reduce:opacity-90 sm:h-[5rem]`}
          aria-hidden
        />
      ))}
    </>
  );
}

function FilteredExposureSummaryStrip({
  summary,
}: {
  summary: DashboardFilteredExposureSummary;
}) {
  const t = useTranslations("dashboard");
  const sep = (
    <span className="text-pv-muted/40" aria-hidden>
      {" "}
      ·{" "}
    </span>
  );

  return (
    <div
      role="region"
      aria-label={t("holdings.exposureSummaryBarAria")}
      className={`mb-3 flex flex-wrap items-baseline gap-x-0.5 ${DASHBOARD_SURFACE_MUTED} px-3 py-2 font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-pv-muted sm:text-[11px]`}
    >
      <span className="tabular-nums text-pv-text">
        {t("holdings.exposureSummaryOpen", { count: summary.openCount })}
      </span>
      {sep}
      <span className="tabular-nums text-pv-text">
        {t("holdings.exposureSummaryLive", { count: summary.liveCount })}
      </span>
      {sep}
      <span className="tabular-nums text-pv-text">
        {t("holdings.exposureSummaryClosed", { count: summary.closedCount })}
      </span>
      {summary.genAtRisk > 0 ? (
        <>
          {sep}
          <span className="tabular-nums text-pv-emerald">
            {t("holdings.exposureSummaryAtRisk", {
              amount: String(Math.round(summary.genAtRisk)),
            })}
          </span>
        </>
      ) : null}
    </div>
  );
}

function StakeHoldingsColumn({
  openKey,
  setOpenKey,
  headerExtra,
  stakeHoldingsSearchQuery,
  filteredVsList,
  showStakeHoldingsMocks,
  exposureFilterKey,
  onResetFilters,
  totalDuelsCount,
  exposureLoading,
  exposureRefreshing,
  viewerAddress,
}: {
  openKey: StakeHoldingOpenKey | null;
  setOpenKey: (key: StakeHoldingOpenKey | null) => void;
  headerExtra?: ReactNode;
  stakeHoldingsSearchQuery: string;
  filteredVsList: VSData[];
  showStakeHoldingsMocks: boolean;
  exposureFilterKey: string;
  onResetFilters: () => void;
  totalDuelsCount: number;
  /** Primera carga sin snapshot aún: esqueleto y sin mocks ni “vacío”. */
  exposureLoading: boolean;
  /** Revalidación con datos en pantalla: atenuar lista y marcar busy. */
  exposureRefreshing: boolean;
  viewerAddress?: string | null;
}) {
  const t = useTranslations("dashboard");

  const isInitialExposureLoad = exposureLoading && totalDuelsCount === 0;

  const [visibleVsCount, setVisibleVsCount] = useState(DASHBOARD_EXPOSURE_PAGE_SIZE);

  useEffect(() => {
    setVisibleVsCount(DASHBOARD_EXPOSURE_PAGE_SIZE);
  }, [exposureFilterKey]);

  const visibleVsSlice = useMemo(
    () => filteredVsList.slice(0, visibleVsCount),
    [filteredVsList, visibleVsCount]
  );

  const hasMoreVs = filteredVsList.length > visibleVsCount;

  const exposureSummary = useMemo(
    () => summarizeDashboardFilteredExposure(filteredVsList, viewerAddress),
    [filteredVsList, viewerAddress]
  );

  const visibleHoldingIds = useMemo(
    () =>
      DASHBOARD_STAKE_HOLDING_IDS.filter((id) =>
        holdingMatchesDashboardSearch(id, stakeHoldingsSearchQuery, t)
      ),
    [stakeHoldingsSearchQuery, t]
  );

  useEffect(() => {
    if (openKey?.startsWith("mock:")) {
      const id = openKey.slice("mock:".length) as DashboardStakeHoldingId;
      if (!visibleHoldingIds.includes(id)) {
        setOpenKey(null);
      }
    }
  }, [openKey, visibleHoldingIds, setOpenKey]);

  const mockSearchEmpty =
    !isInitialExposureLoad &&
    stakeHoldingsSearchQuery.trim().length > 0 &&
    visibleHoldingIds.length === 0;

  const noVsMatchFilters =
    !isInitialExposureLoad &&
    filteredVsList.length === 0 &&
    totalDuelsCount > 0 &&
    !mockSearchEmpty;

  const noDuelsAtAll =
    !isInitialExposureLoad &&
    filteredVsList.length === 0 &&
    totalDuelsCount === 0 &&
    !showStakeHoldingsMocks;

  const mockOnlySearchEmpty =
    !isInitialExposureLoad &&
    mockSearchEmpty &&
    showStakeHoldingsMocks &&
    filteredVsList.length === 0;

  const showMocksBlock =
    !isInitialExposureLoad && showStakeHoldingsMocks && !mockSearchEmpty;

  const pagingSummary =
    !isInitialExposureLoad && filteredVsList.length > 0 ? (
      visibleVsSlice.length < filteredVsList.length ? (
        <p
          className="mb-1 font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-pv-muted sm:text-[11px]"
          aria-live="polite"
        >
          {t("holdings.exposurePagingPartial", {
            visible: visibleVsSlice.length,
            total: filteredVsList.length,
          })}
        </p>
      ) : (
        <p
          className="mb-1 font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-pv-muted sm:text-[11px]"
          aria-live="polite"
        >
          {t("holdings.exposurePagingAll", { total: filteredVsList.length })}
        </p>
      )
    ) : null;

  return (
    <section
      id="dashboard-exposure"
      className="min-w-0 scroll-mt-[calc(3.5rem+env(safe-area-inset-top,0px)+12px)] lg:col-span-7 xl:col-span-8"
      aria-label={t("holdings.sectionAria")}
    >
      {!isInitialExposureLoad && exposureSummary.filteredTotal > 0 ? (
        <FilteredExposureSummaryStrip summary={exposureSummary} />
      ) : null}
      {headerExtra ? (
        <div className="sticky top-[calc(3.5rem+env(safe-area-inset-top,0px))] z-40 mb-4 bg-pv-bg/92 py-2 backdrop-blur-md supports-[backdrop-filter]:bg-pv-bg/78">
          {headerExtra}
        </div>
      ) : null}
      {pagingSummary}
      <div
        className={`flex flex-col gap-3 sm:gap-4 ${exposureRefreshing && totalDuelsCount > 0 ? "opacity-60 transition-opacity duration-200" : ""}`}
        aria-busy={exposureRefreshing && totalDuelsCount > 0}
      >
        {isInitialExposureLoad ? (
          <div
            className="flex flex-col gap-3 sm:gap-4"
            role="status"
            aria-label={t("holdings.listLoadingAria")}
          >
            <span className="sr-only">{t("holdings.listLoadingAria")}</span>
            <ExposureListSkeleton count={DASHBOARD_EXPOSURE_PAGE_SIZE} />
          </div>
        ) : null}

        {!isInitialExposureLoad && mockOnlySearchEmpty ? (
          <p
            className={`${DASHBOARD_SURFACE_DASHED} px-4 py-6 text-center font-mono text-xs text-pv-muted sm:text-sm`}
            role="status"
          >
            {t("holdings.searchEmpty")}
          </p>
        ) : null}

        {!isInitialExposureLoad && noVsMatchFilters ? (
          <div
            className={`${DASHBOARD_SURFACE_DASHED} px-4 py-6 text-center sm:px-6`}
            role="status"
          >
            <p className="font-mono text-xs text-pv-muted sm:text-sm">
              {t("filterNoResultsDesc")}
            </p>
            <button
              type="button"
              onClick={onResetFilters}
              className="focus-ring mt-4 inline-flex min-h-[44px] items-center justify-center rounded-lg border border-pv-ink/[0.1] bg-pv-ink/[0.04] px-4 py-2 font-display text-[10px] font-bold uppercase tracking-[0.16em] text-pv-text transition-colors hover:border-pv-emerald/35 hover:bg-pv-emerald/[0.08] hover:text-pv-emerald"
            >
              {t("resetFiltersAction")}
            </button>
          </div>
        ) : null}

        {!isInitialExposureLoad && noDuelsAtAll ? (
          <div
            className={`${DASHBOARD_SURFACE_DASHED} px-4 py-6 text-center sm:px-6`}
            role="status"
          >
            <p className="font-mono text-xs text-pv-muted sm:text-sm">
              {t("noVSDesc")}
            </p>
            <div className="mt-5 flex flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-center">
              <Link
                href="/vs/create"
                className="focus-ring inline-flex min-h-[44px] items-center justify-center rounded-lg border border-pv-emerald/50 bg-pv-emerald px-5 py-2.5 font-display text-[10px] font-bold uppercase tracking-[0.16em] text-pv-bg transition-colors hover:border-pv-emerald hover:bg-pv-emerald/90 sm:text-[11px]"
              >
                {t("holdings.emptyCtaCreate")}
              </Link>
              <Link
                href="/explorer"
                className="focus-ring inline-flex min-h-[44px] items-center justify-center rounded-lg border border-pv-ink/[0.1] bg-pv-ink/[0.04] px-5 py-2.5 font-display text-[10px] font-bold uppercase tracking-[0.16em] text-pv-text transition-colors hover:border-pv-emerald/35 hover:bg-pv-emerald/[0.08] hover:text-pv-emerald sm:text-[11px]"
              >
                {t("holdings.emptyCtaExplore")}
              </Link>
            </div>
          </div>
        ) : null}

        {!isInitialExposureLoad
          ? visibleVsSlice.map((vs) => {
              const rowKey = `vs:${vs.id}` as const;
              return (
                <StakeHoldingVSRow
                  key={vs.id}
                  vs={vs}
                  isOpen={openKey === rowKey}
                  onToggle={() => setOpenKey(openKey === rowKey ? null : rowKey)}
                  viewerAddress={viewerAddress}
                />
              );
            })
          : null}

        {!isInitialExposureLoad && hasMoreVs ? (
          <button
            type="button"
            onClick={() =>
              setVisibleVsCount((c) =>
                Math.min(
                  c + DASHBOARD_EXPOSURE_LOAD_MORE,
                  filteredVsList.length
                )
              )
            }
            className={`focus-ring mx-auto mt-1 flex min-h-[44px] w-full max-w-md items-center justify-center ${DASHBOARD_SURFACE_MUTED} px-4 py-2.5 font-display text-[10px] font-bold uppercase tracking-[0.18em] text-pv-muted transition-colors hover:border-pv-emerald/30 hover:bg-pv-emerald/[0.08] hover:text-pv-emerald sm:text-[11px]`}
          >
            {t("holdings.loadMore")}
          </button>
        ) : null}

        {!isInitialExposureLoad && mockSearchEmpty && !mockOnlySearchEmpty ? (
          <p
            className={`${DASHBOARD_SURFACE_DASHED} px-4 py-6 text-center font-mono text-xs text-pv-muted sm:text-sm`}
            role="status"
          >
            {t("holdings.searchEmpty")}
          </p>
        ) : null}

        {showMocksBlock
          ? visibleHoldingIds.map((id) => (
              <StakeHoldingRow
                key={id}
                id={id}
                isOpen={openKey === `mock:${id}`}
                onToggle={() =>
                  setOpenKey(openKey === `mock:${id}` ? null : `mock:${id}`)
                }
              />
            ))
          : null}
      </div>
    </section>
  );
}

export function RiskAllocationProfileCard({
  wins,
  losses,
  className = "",
}: {
  wins: number;
  losses: number;
  className?: string;
}) {
  const t = useTranslations("dashboard");
  const riskProfile = useMemo(
    () => toRiskProfilePct(wins, losses),
    [wins, losses]
  );

  return (
    <section
      className={`${DASHBOARD_PANEL_SURFACE} ${className}`}
      aria-label={t("holdings.riskSectionAria")}
    >
      <h2 className="mb-5 font-display text-xs font-bold uppercase tracking-[0.18em] text-pv-text sm:text-[11px] sm:tracking-[0.2em]">
        {t("holdings.riskTitle")}
      </h2>
      <div className="space-y-5">
        {riskProfile.map((row) => (
          <div key={row.key}>
            <div className="flex items-baseline justify-between gap-2">
              <span className="font-display text-[10px] font-bold uppercase tracking-[0.14em] text-pv-muted">
                {t(`holdings.risk.${row.key}` as never)}
              </span>
              <span className="font-mono text-[11px] font-bold tabular-nums text-pv-text">
                {row.pct}%
              </span>
            </div>
            <div
              className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-pv-ink/[0.08]"
              role="progressbar"
              aria-valuenow={row.pct}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <motion.div
                className="h-full rounded-full bg-pv-emerald"
                initial={{ width: 0 }}
                animate={{ width: `${row.pct}%` }}
                transition={{ duration: 0.65, ease, delay: 0.05 }}
              />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function RiskAndActionsColumn({
  wins,
  losses,
  asideRefreshing,
}: {
  wins: number;
  losses: number;
  asideRefreshing: boolean;
}) {
  const t = useTranslations("dashboard");

  return (
    <aside
      className={`flex min-w-0 flex-col gap-4 lg:col-span-5 xl:col-span-4 ${
        asideRefreshing ? "opacity-60 transition-opacity duration-200" : ""
      }`}
      aria-busy={asideRefreshing}
    >
      <RiskAllocationProfileCard
        wins={wins}
        losses={losses}
        className="hidden lg:block"
      />

      <section
        className={DASHBOARD_PANEL_SURFACE}
        aria-label={t("holdings.quickActionsAria")}
      >
        <h2 className="mb-4 font-display text-xs font-bold uppercase tracking-[0.18em] text-pv-muted sm:mb-5 sm:text-sm sm:tracking-[0.2em]">
          {t("holdings.quickActionsTitle")}
        </h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-3">
          <Link
            href="/vs/create"
            className="group flex min-h-[3.75rem] items-center justify-center gap-3 rounded-lg border border-pv-emerald/45 bg-pv-emerald/[0.08] px-4 py-3.5 text-center font-display text-xs font-bold uppercase leading-snug tracking-wide text-pv-emerald transition-[color,border-color,background-color] duration-300 hover:border-pv-emerald/65 hover:bg-pv-emerald/[0.14] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pv-emerald/40 focus-visible:ring-offset-2 focus-visible:ring-offset-pv-bg sm:min-h-[4rem] sm:px-5 sm:text-sm"
          >
            <CirclePlus
              size={22}
              strokeWidth={2}
              className="shrink-0 text-pv-emerald transition-colors duration-300 group-hover:text-pv-emerald"
              aria-hidden
            />
            <span>{t("holdings.actionCreate")}</span>
          </Link>
          <Link
            href="/explorer"
            className="group flex min-h-[3.75rem] items-center justify-center gap-3 rounded-lg border border-pv-ink/[0.1] bg-transparent px-4 py-3.5 text-center font-display text-xs font-bold uppercase leading-snug tracking-wide text-pv-muted transition-[color,border-color,background-color] duration-300 hover:border-pv-ink/[0.2] hover:bg-pv-ink/[0.04] hover:text-pv-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pv-emerald/40 focus-visible:ring-offset-2 focus-visible:ring-offset-pv-bg sm:min-h-[4rem] sm:px-5 sm:text-sm"
          >
            <Compass
              size={22}
              strokeWidth={2}
              className="shrink-0 text-pv-muted transition-colors duration-300 group-hover:text-pv-text"
              aria-hidden
            />
            <span>{t("holdings.actionAnalysis")}</span>
          </Link>
          <button
            type="button"
            className={`flex min-h-[3.75rem] w-full cursor-not-allowed items-center justify-center gap-3 ${DASHBOARD_SURFACE_DASHED} px-4 py-3.5 text-center font-display text-xs font-bold uppercase leading-snug tracking-wide text-pv-muted opacity-90 sm:col-span-2 sm:min-h-[4rem] sm:px-5 sm:text-sm`}
            disabled
            title={t("holdings.withdrawSoon")}
          >
            <img
              src="/icons/wallet.svg"
              alt=""
              width={22}
              height={22}
              className="h-[22px] w-[22px] shrink-0 object-contain opacity-90 [filter:invert(1)]"
              aria-hidden
            />
            <span>{t("holdings.actionWithdraw")}</span>
          </button>
        </div>
      </section>

      <section
        className={`${DASHBOARD_SURFACE_DASHED} px-4 py-8 text-center transition-colors duration-300 hover:border-pv-ink/[0.16] sm:py-9`}
        aria-label={t("holdings.friendsAria")}
      >
        <h2 className="font-display text-xs font-bold uppercase tracking-[0.22em] text-pv-muted">
          {t("holdings.friendsTitle")}
        </h2>
        <p className="mt-2 font-mono text-[10px] text-pv-muted/90 sm:text-[11px]">
          {t("holdings.friendsHint")}
        </p>
      </section>
    </aside>
  );
}

export default function DashboardPortfolioSection({
  stakeHoldingsHeaderExtra,
  stakeHoldingsSearchQuery = "",
  filteredVsList,
  showStakeHoldingsMocks,
  exposureFilterKey,
  onResetFilters,
  totalDuelsCount,
  wins = 0,
  losses = 0,
  exposureLoading = false,
  exposureRefreshing = false,
  viewerAddress,
}: {
  stakeHoldingsHeaderExtra?: ReactNode;
  /** Misma cadena que el input de búsqueda del filtro VS (filtra filas de tenencias mock). */
  stakeHoldingsSearchQuery?: string;
  /** Lista de VS del usuario tras tabs + filtros Explore (fuente única Active Exposure). */
  filteredVsList: VSData[];
  showStakeHoldingsMocks: boolean;
  /** Cambia cuando cambian filtros; resetea el paginado “Load more”. */
  exposureFilterKey: string;
  onResetFilters: () => void;
  totalDuelsCount: number;
  wins?: number;
  losses?: number;
  exposureLoading?: boolean;
  exposureRefreshing?: boolean;
  viewerAddress?: string | null;
}) {
  const [openKey, setOpenKey] = useState<StakeHoldingOpenKey | null>(null);

  return (
    <div className="mb-10 grid grid-cols-1 gap-8 lg:grid-cols-12 lg:gap-10 xl:gap-12">
      <StakeHoldingsColumn
        openKey={openKey}
        setOpenKey={setOpenKey}
        headerExtra={stakeHoldingsHeaderExtra}
        stakeHoldingsSearchQuery={stakeHoldingsSearchQuery}
        filteredVsList={filteredVsList}
        showStakeHoldingsMocks={showStakeHoldingsMocks}
        exposureFilterKey={exposureFilterKey}
        onResetFilters={onResetFilters}
        totalDuelsCount={totalDuelsCount}
        exposureLoading={exposureLoading}
        exposureRefreshing={exposureRefreshing}
        viewerAddress={viewerAddress}
      />
      <RiskAndActionsColumn
        wins={wins}
        losses={losses}
        asideRefreshing={exposureRefreshing && totalDuelsCount > 0}
      />
    </div>
  );
}
