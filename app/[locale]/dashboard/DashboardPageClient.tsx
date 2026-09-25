"use client";

import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { motion } from "framer-motion";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { useWallet } from "@/lib/wallet";
import {
  didUserLoseVS,
  getUserVSSnapshot,
  didUserWinVS,
  getVSUserWinAmount,
  type VSData,
} from "@/lib/contract";
import type { VSCacheFreshness } from "@/lib/vs-freshness";
import { mergePendingVS } from "@/lib/pending-vs";
import { applyExploreFilters } from "@/lib/exploreFilters";
import PageTransition, { AnimatedItem } from "@/components/PageTransition";
import { BlueprintHeading } from "@/components/BlueprintGrid";
import { LiveStat } from "@/components/ui";
import { shouldShowDashboardStakeHoldingsMocks } from "@/lib/dashboardUiPolicy";
import DashboardPortfolioSection, {
  RiskAllocationProfileCard,
} from "@/components/dashboard/DashboardPortfolioSection";
import DashboardWalletGate from "@/components/dashboard/DashboardWalletGate";
import AccountBalances from "@/components/wallet/AccountBalances";
import DashboardKpiSkeletonRow from "@/components/dashboard/DashboardKpiSkeletonRow";
import PortfolioPerformancePanel from "@/components/dashboard/PortfolioPerformancePanel";
import DashboardVSFilterBar from "@/components/dashboard/DashboardVSFilterBar";
import CacheFreshnessPill from "@/components/CacheFreshnessPill";
import StaleIndexWarning from "@/components/StaleIndexWarning";
import { useDashboardFilterUrlState } from "@/hooks/useDashboardFilterUrlState";
import {
  DASHBOARD_CARD_HOVER,
  DASHBOARD_CARD_SURFACE,
} from "@/lib/dashboardSurface";
import { Zap } from "lucide-react";

const dashboardKpiCardClass = `min-w-0 ${DASHBOARD_CARD_SURFACE} p-5 text-center ${DASHBOARD_CARD_HOVER} sm:p-6`;

const dashboardKpiLabelClass =
  "mt-1 font-mono text-[12px] font-bold uppercase tracking-[0.15em] text-pv-muted/60";

/** Alineado con píldoras de Explore (`ExploreClient`). */
const filterPillBase =
  "shrink-0 rounded border px-4 py-2.5 font-display text-xs font-bold uppercase tracking-tight transition-[color,border-color,background-color] focus-ring min-h-[44px]";
const filterPillActive = "border-pv-emerald/50 bg-pv-emerald text-pv-bg";

const listItemEase = [0.25, 0.1, 0.25, 1] as const;

export default function DashboardPageClient() {
  const { address, isConnected, isConnecting, connect } = useWallet();
  const [duels, setDuels] = useState<VSData[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [snapshotCache, setSnapshotCache] = useState<VSCacheFreshness | null>(
    null
  );
  const [loadError, setLoadError] = useState<string | null>(null);
  const {
    tab,
    setTab,
    searchQuery,
    setSearchQuery,
    categoryFilter,
    setCategoryFilter,
    minStakeFilter,
    setMinStakeFilter,
    resetFilters,
  } = useDashboardFilterUrlState();
  const requestIdRef = useRef(0);
  const t = useTranslations("dashboard");

  const loadDuels = useCallback(
    async ({
      forceRefresh = false,
      showPageLoading = false,
    }: {
      forceRefresh?: boolean;
      showPageLoading?: boolean;
    } = {}) => {
      const requestId = ++requestIdRef.current;

      if (!address) {
        setLoading(false);
        setRefreshing(false);
        return;
      }

      if (showPageLoading) {
        setLoading(true);
      }
      if (forceRefresh) {
        setRefreshing(true);
      }

      try {
        const results = await getUserVSSnapshot(address, { forceRefresh });
        results.items.sort((a, b) => b.id - a.id);
        if (requestId === requestIdRef.current) {
          setDuels(mergePendingVS(results.items, address));
          setSnapshotCache(results.cache ?? null);
          setLoadError(null);
        }
      } catch (e) {
        console.error(e);
        if (requestId === requestIdRef.current) {
          setLoadError(t("loadFailed"));
        }
      } finally {
        if (requestId === requestIdRef.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [address, t]
  );

  useEffect(() => {
    void loadDuels({ showPageLoading: true });
  }, [loadDuels]);

  /** Debe ejecutarse en todo render (incluso si !isConnected): no condicionar hooks tras un return. */
  const tabFiltered = useMemo(() => {
    if (tab === "all") return duels;
    if (tab === "active") {
      return duels.filter(
        (d) => d.state === "open" || d.state === "accepted"
      );
    }
    return duels.filter(
      (d) => d.state === "resolved" || d.state === "cancelled"
    );
  }, [tab, duels]);

  const filtered = useMemo(
    () =>
      applyExploreFilters(tabFiltered, {
        cat: categoryFilter,
        minStake: minStakeFilter,
        sort: "newest",
        search: searchQuery,
        needsChallengers: false,
        expiringSoon: false,
        participation: "all",
        // The dashboard shows the user's own positions; underdog is a discovery
        // filter for the explorer, not a lens on markets you are already in.
        underdogOnly: false,
      }),
    [tabFiltered, categoryFilter, minStakeFilter, searchQuery]
  );

  const exposureFilterKey = useMemo(
    () => `${tab}-${searchQuery}-${categoryFilter}-${minStakeFilter}`,
    [tab, searchQuery, categoryFilter, minStakeFilter]
  );

  const showStakeHoldingsMocks = useMemo(
    () => shouldShowDashboardStakeHoldingsMocks(duels),
    [duels]
  );

  if (!isConnected) {
    return (
      <DashboardWalletGate onConnect={connect} isConnecting={isConnecting} />
    );
  }

  const won = duels.filter(
    (d) => d.state === "resolved" && didUserWinVS(d, address)
  ).length;
  const lost = duels.filter(
    (d) => d.state === "resolved" && didUserLoseVS(d, address)
  ).length;
  const totalWon = duels
    .filter((d) => d.state === "resolved" && didUserWinVS(d, address))
    .reduce((sum, duel) => sum + (getVSUserWinAmount(duel, address) ?? 0), 0);
  const winRate =
    won + lost > 0 ? Math.round((won / (won + lost)) * 100) : 0;

  const tabs = [
    { l: t("tabAll"), v: "all" as const, count: duels.length },
    {
      l: t("tabActive"),
      v: "active" as const,
      count: duels.filter((d) => d.state === "open" || d.state === "accepted")
        .length,
    },
    {
      l: t("tabDone"),
      v: "done" as const,
      count: duels.filter(
        (d) => d.state === "resolved" || d.state === "cancelled"
      ).length,
    },
  ];

  /* ── Streak calculation ── */
  const recentResolved = duels
    .filter((d) => d.state === "resolved")
    .slice(0, 20);
  let streakType: "W" | "L" | null = null;
  let streakCount = 0;
  for (const d of recentResolved) {
    const w = didUserWinVS(d, address);
    const l = didUserLoseVS(d, address);
    const curr = w ? "W" : l ? "L" : null;
    if (!curr) continue;
    if (streakType === null) {
      streakType = curr;
      streakCount = 1;
    } else if (curr === streakType) {
      streakCount++;
    } else {
      break;
    }
  }
  const streakLabel = streakCount >= 2 ? `${streakCount}${streakType}` : null;

  const showKpiSkeleton = loading && duels.length === 0 && !loadError;
  const showKpiCards = duels.length > 0;

  return (
    <PageTransition>
      <AnimatedItem>
        <div className="mb-8 sm:mb-10">
          <BlueprintHeading>{t("title")}</BlueprintHeading>
          <div className="mt-4 flex flex-wrap items-center justify-center gap-3 sm:gap-4">
            <div className="flex items-center gap-1.5">
              <div
                className="h-1.5 w-1.5 rounded-full bg-pv-emerald shadow-[0_0_8px_rgba(51,79,169,0.6)]"
                aria-hidden
              />
              <span className="font-mono text-xs text-pv-muted">
                {t("total", { count: duels.length })}
              </span>
            </div>
            {snapshotCache && !loadError ? (
              <CacheFreshnessPill freshness={snapshotCache} />
            ) : null}
            <Link
              href="/vs/create"
              className={`inline-flex items-center justify-center no-underline ${filterPillBase} ${filterPillActive}`}
            >
              {t("new")}
            </Link>
          </div>
        </div>
      </AnimatedItem>

      <StaleIndexWarning
        freshness={snapshotCache}
        refreshing={refreshing}
        onRefresh={() => void loadDuels({ forceRefresh: true })}
      />

      {loadError ? (
        <AnimatedItem>
          <div
            role="alert"
            className="mb-4 flex flex-col gap-3 rounded-lg border border-red-400/35 bg-red-400/[0.08] px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5"
          >
            <p className="font-mono text-xs text-red-200/95 sm:text-sm">
              {loadError}
            </p>
            <button
              type="button"
              onClick={() => void loadDuels({ forceRefresh: true })}
              className="focus-ring shrink-0 self-start rounded border border-red-400/40 bg-red-400/10 px-4 py-2 font-display text-[10px] font-bold uppercase tracking-[0.16em] text-red-100 transition-colors hover:border-red-400/60 hover:bg-red-400/20 sm:self-auto sm:text-[11px]"
            >
              {t("loadFailedRetry")}
            </button>
          </div>
        </AnimatedItem>
      ) : null}

      {showKpiSkeleton || showKpiCards ? (
        <AnimatedItem>
          <section
            className={`mb-6 ${showKpiCards && loading ? "opacity-70" : ""}`}
            aria-label={t("statsSectionAria")}
            aria-busy={showKpiSkeleton}
          >
            {showKpiSkeleton ? (
              <>
                <span className="sr-only">{t("kpiStatsLoading")}</span>
                <DashboardKpiSkeletonRow />
              </>
            ) : (
            <>
            {/*
              Four KPI tiles: mismo patrón visual que la franja de stats de la home
              (`page.tsx`): grid + tarjetas con borde suave y LiveStat grande.
              Racha (≥2) en la tarjeta que coincide con streakType.
            */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 sm:gap-4">
              {/* Challenges won */}
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.4, delay: 0, ease: listItemEase }}
                className={dashboardKpiCardClass}
                aria-label={`${t("challengesWonTitle")}: ${won}`}
              >
                <div className="flex flex-col items-center">
                  <div className="flex min-h-[2.75rem] items-center justify-center gap-1.5 sm:min-h-[3.25rem]">
                    <LiveStat
                      value={won}
                      size="lg"
                      color="emerald"
                      className="items-center"
                    />
                    {streakLabel && streakType === "W" ? (
                      <span className="inline-flex shrink-0 items-center gap-0.5 rounded-full border border-pv-emerald/30 bg-pv-emerald/10 px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wider text-pv-emerald">
                        <Zap size={8} aria-hidden />
                        {streakLabel}
                      </span>
                    ) : null}
                  </div>
                  <span className={dashboardKpiLabelClass}>
                    {t("challengesWonTitle")}
                  </span>
                </div>
              </motion.div>

              {/* Challenges lost */}
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.4, delay: 0.05, ease: listItemEase }}
                className={dashboardKpiCardClass}
                aria-label={`${t("challengesLostTitle")}: ${lost}`}
              >
                <div className="flex flex-col items-center">
                  <div className="flex min-h-[2.75rem] items-center justify-center gap-1.5 sm:min-h-[3.25rem]">
                    <LiveStat
                      value={lost}
                      size="lg"
                      color="text"
                      className="items-center"
                    />
                    {streakLabel && streakType === "L" ? (
                      <span className="inline-flex shrink-0 items-center gap-0.5 rounded-full border border-red-400/30 bg-red-400/10 px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wider text-red-400">
                        <Zap size={8} aria-hidden />
                        {streakLabel}
                      </span>
                    ) : null}
                  </div>
                  <span className={dashboardKpiLabelClass}>
                    {t("challengesLostTitle")}
                  </span>
                </div>
              </motion.div>

              {/* Win rate */}
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.4, delay: 0.1, ease: listItemEase }}
                className={dashboardKpiCardClass}
              >
                <LiveStat
                  value={winRate}
                  suffix="%"
                  size="lg"
                  color="emerald"
                  label={t("winRate")}
                  labelPosition="below"
                  labelClassName="text-[12px]"
                  className="items-center"
                />
              </motion.div>

              {/* Total winnings */}
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.4, delay: 0.15, ease: listItemEase }}
                className={dashboardKpiCardClass}
              >
                <LiveStat
                  value={totalWon}
                  suffix="USDC"
                  size="lg"
                  color="gold"
                  label={t("totalWon")}
                  labelPosition="below"
                  labelClassName="text-[12px]"
                  className="items-center"
                />
              </motion.div>
            </div>
            </>
            )}
          </section>
        </AnimatedItem>
      ) : null}

      {address ? (
        <AnimatedItem>
          <PortfolioPerformancePanel address={address} />
        </AnimatedItem>
      ) : null}

      {/* The wallet/account area. `withdraw()` and `claimFees()` are pull-only on
          Soroban, so this is the only place either can be called from — a parked
          payment with no entry point is stranded money, not a missing nicety. */}
      <AnimatedItem>
        <div className="mb-6">
          <AccountBalances />
        </div>
      </AnimatedItem>

      <AnimatedItem>
        <div className="mt-2 mb-8 lg:hidden">
          <RiskAllocationProfileCard wins={won} losses={lost} />
        </div>
      </AnimatedItem>

      <AnimatedItem>
        <DashboardPortfolioSection
          filteredVsList={filtered}
          showStakeHoldingsMocks={showStakeHoldingsMocks}
          exposureFilterKey={exposureFilterKey}
          onResetFilters={resetFilters}
          totalDuelsCount={duels.length}
          wins={won}
          losses={lost}
          viewerAddress={address ?? undefined}
          stakeHoldingsSearchQuery={searchQuery}
          exposureLoading={loading && duels.length === 0}
          exposureRefreshing={refreshing}
          stakeHoldingsHeaderExtra={
            <DashboardVSFilterBar
              tab={tab}
              onTabChange={setTab}
              tabs={tabs}
              searchQuery={searchQuery}
              onSearchChange={setSearchQuery}
              categoryFilter={categoryFilter}
              onCategoryChange={setCategoryFilter}
              minStakeFilter={minStakeFilter}
              onMinStakeFilterChange={setMinStakeFilter}
              refreshing={refreshing}
              onRefresh={() => {
                void loadDuels({ forceRefresh: true });
              }}
            />
          }
        />
      </AnimatedItem>
    </PageTransition>
  );
}
