"use client";

import { motion } from "framer-motion";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import {
  getVSChallengerCount,
  getVSTotalPot,
  isVSJoinable,
  type VSData,
} from "@/lib/contract";
import { shortenAddress, getCategoryInfo, ZERO_ADDRESS } from "@/lib/constants";
import { toCanonicalMode } from "@/lib/market-modes";
import { poolBalance } from "@/lib/payout";
import { assessUnderdog } from "@/lib/underdog";
import { usdcToUnits } from "@/lib/usdc";
import VSStrip from "./ui/VSStrip";

interface VSCardProps {
  vs: VSData;
  showCategory?: boolean;
  showAcceptCTA?: boolean;
  /** VS de demostración (ids negativos): estilo distinto + badge opcional */
  isSample?: boolean;
  sampleBadgeLabel?: string;
  /**
   * Si se define, la píldora de categoría enlaza a Explore con `?cat=` (misma categoría que `vs.category`).
   * Usa overlay + `pointer-events` para evitar `<a>` anidados.
   */
  categoryFilterHref?: string;
  /** Texto "challenges" junto al creador (p. ej. Explore lo oculta) */
  showChallengesLabel?: boolean;
}

/** Misma píldora que ArenaCard (categoría + POOL): sin borde blanco del `.chip` global */
const vsCardPillClass =
  "rounded border border-pv-emerald/25 bg-pv-emerald/[0.06] px-2 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.12em] text-pv-emerald/90";

export default function VSCard({
  vs,
  showCategory = false,
  showAcceptCTA = false,
  isSample = false,
  sampleBadgeLabel,
  categoryFilterHref,
  showChallengesLabel = true,
}: VSCardProps) {
  const catInfo = getCategoryInfo(vs.category);
  const isOpen = vs.opponent === ZERO_ADDRESS;
  const pool = getVSTotalPot(vs);
  const isJoinable = isVSJoinable(vs);
  const challengerCount = getVSChallengerCount(vs);
  const maxChallengers =
    typeof vs.max_challengers === "number" && vs.max_challengers > 0
      ? vs.max_challengers
      : 1;
  // Quoted for a 2 USDC probe stake: in a pool market a large stake dilutes its
  // own payout, so an unqualified multiple would overstate what a joiner gets.
  const underdog = assessUnderdog(vs);
  const marketType = vs.market_type ?? "binary";
  const oddsMode = vs.odds_mode ?? "pool";
  const canonicalMode = toCanonicalMode({
    marketType,
    oddsMode,
    maxChallengers,
  });
  const creatorPool = Math.max(0, vs.creator_stake ?? vs.stake_amount ?? 0);
  const challengerPool = Math.max(0, vs.total_challenger_stake ?? 0);
  const poolShape = poolBalance({
    creatorStakeUnits: usdcToUnits(creatorPool),
    challengerPoolUnits: usdcToUnits(challengerPool),
  });
  const creatorSharePercent = poolShape.creatorShareBps / 100;
  const challengerSharePercent = 100 - creatorSharePercent;
  const formatAmount = (amount: number) =>
    amount.toLocaleString("en-US", { maximumFractionDigits: 6 });
  const t = useTranslations("vsDetail");
  const tCat = useTranslations("categories");

  const cardState = vs.state ?? "unknown";
  const cardDisabled = cardState === "cancelled";

  return (
    <motion.div
      data-market-card={String(vs.id)}
      data-market-card-state={cardState}
      data-market-card-disabled={cardDisabled ? "true" : undefined}
      whileHover={{ y: -2 }}
      transition={{ duration: 0.2 }}
      className={`group card card-hover relative p-5 ${
        isSample
          ? "border border-dashed border-pv-emerald/35 bg-pv-surface/80 ring-1 ring-pv-emerald/[0.12]"
          : ""
      }`}
    >
      <Link
        href={`/vs/${vs.id}`}
        data-market-card-focus
        className="absolute inset-0 z-0 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pv-emerald/40 focus-visible:ring-offset-2 focus-visible:ring-offset-pv-surface"
        aria-label={vs.question}
      />

      <div className="pointer-events-none absolute left-0 top-0 h-full w-2/5 bg-[radial-gradient(ellipse_at_0%_50%,rgba(51,79,169,0.06),transparent_65%)]" />

      <div className="relative z-10 pointer-events-none">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-x-2 gap-y-2">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            {isSample && sampleBadgeLabel ? (
              <span className={`shrink-0 ${vsCardPillClass} tracking-[0.14em]`}>
                {sampleBadgeLabel}
              </span>
            ) : null}
            <span className="text-[13px] font-semibold">
              {shortenAddress(vs.creator)}
            </span>
            {showChallengesLabel ? (
              <span className="text-xs text-pv-muted">{t("challenges")}</span>
            ) : null}
            {/* Payout asymmetry only — never a claim about who is likely to win.
                Shown only when the side a browsing user CAN take is the thin one;
                badging a market where the creator is the underdog would point at a
                position nobody can join. */}
            {underdog.isUnderdog && underdog.minoritySide === "challengers" ? (
              <span
                title={t("underdogBadgeHint", {
                  multiple: underdog.challengerReturnMultiple.toFixed(2),
                })}
                className="shrink-0 rounded-full border border-pv-gold/30 bg-pv-gold/[0.1] px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.14em] text-pv-gold"
              >
                {t("underdogBadge")}
              </span>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            {showCategory &&
              (categoryFilterHref ? (
                <Link
                  href={categoryFilterHref}
                  className={`pointer-events-auto inline-block ${vsCardPillClass} transition-colors hover:border-pv-emerald/35 hover:bg-pv-emerald/[0.1]`}
                  onClick={(e) => e.stopPropagation()}
                >
                  {tCat(catInfo.id)}
                </Link>
              ) : (
                <span className={vsCardPillClass}>{tCat(catInfo.id)}</span>
              ))}
            <span className="font-mono text-[13px] font-bold text-pv-gold">
              {pool} USDC
            </span>
          </div>
        </div>

        <div className="font-display text-lg font-bold leading-snug mb-3.5 tracking-tight">
          {vs.question}
        </div>

        <VSStrip
          creator={vs.creator}
          creatorPosition={vs.creator_position}
          opponent={vs.opponent}
          opponentPosition={vs.opponent_position}
          isOpen={isOpen}
          compact
        />

        {canonicalMode.settlementMode === "pool" ? (
          <div className="mt-3 overflow-hidden rounded-lg border border-pv-ink/[0.08] bg-pv-bg/25">
            <div className="grid grid-cols-3 divide-x divide-pv-ink/[0.07]">
              <div className="min-w-0 px-2.5 py-2">
                <div className="truncate text-[9px] font-bold uppercase tracking-[0.12em] text-pv-muted">{t("creatorPool")}</div>
                <div className="mt-1 truncate font-mono text-xs font-bold tabular-nums text-pv-cyan">{formatAmount(creatorPool)}</div>
              </div>
              <div className="min-w-0 px-2.5 py-2">
                <div className="truncate text-[9px] font-bold uppercase tracking-[0.12em] text-pv-muted">{t("challengerPool")}</div>
                <div className="mt-1 truncate font-mono text-xs font-bold tabular-nums text-pv-fuch">{formatAmount(challengerPool)}</div>
              </div>
              <div className="min-w-0 px-2.5 py-2">
                <div className="truncate text-[9px] font-bold uppercase tracking-[0.12em] text-pv-muted">{t("totalPot")}</div>
                <div className="mt-1 truncate font-mono text-xs font-bold tabular-nums text-pv-gold">{formatAmount(pool)}</div>
              </div>
            </div>
            <div className="border-t border-pv-ink/[0.07] px-2.5 py-2">
              <div
                className="flex h-1.5 overflow-hidden rounded-full bg-pv-fuch/50"
                title={t("poolImbalance", {
                  creator: creatorSharePercent.toFixed(1),
                  challengers: challengerSharePercent.toFixed(1),
                })}
              >
                <span className="h-full bg-pv-cyan" style={{ width: `${creatorSharePercent}%` }} />
              </div>
              <div className="mt-1.5 flex items-center justify-between gap-2 font-mono text-[9px] tabular-nums text-pv-muted">
                <span>{t("creatorShare", { percent: creatorSharePercent.toFixed(1) })}</span>
                <span>{t("challengerShare", { percent: challengerSharePercent.toFixed(1) })}</span>
              </div>
            </div>
          </div>
        ) : null}

          <div className="flex flex-wrap gap-2 mt-3">
            <span className="px-2 py-1 rounded text-[10px] font-bold uppercase tracking-[0.12em] border border-pv-cyan/[0.25] bg-pv-cyan/[0.08] text-pv-cyan">
              {t(`marketTypes.${marketType}`)}
            </span>
            <span className="px-2 py-1 rounded text-[10px] font-bold uppercase tracking-[0.12em] border border-pv-fuch/[0.25] bg-pv-fuch/[0.08] text-pv-fuch">
              {oddsMode === "fixed" ? t("oddsModes.fixed") : t("oddsModes.pool")}
            </span>
            <span className="px-2 py-1 rounded text-[10px] font-mono font-bold uppercase tracking-[0.12em] border border-pv-emerald/30 bg-pv-emerald/[0.08] text-pv-emerald">
              {t("slotsFilled", { count: challengerCount, total: maxChallengers })}
            </span>
          </div>

          {showAcceptCTA && isJoinable && (
            <div className="w-full py-3 mt-3.5 rounded bg-pv-fuch/[0.08] border border-pv-fuch/[0.2] text-center font-display text-sm font-bold text-pv-fuch group-hover:bg-pv-fuch/[0.13] transition-colors">
              {t("acceptAndStake", { amount: vs.stake_amount })}
            </div>
          )}
        </div>
    </motion.div>
  );
}
