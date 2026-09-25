"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useLocale, useTranslations } from "next-intl";
import { useWallet } from "@/lib/wallet";
import {
  getAllVSSnapshot,
  getVSChallengerCount,
  isVSJoinable,
  didUserChallengeVS,
  type VSData,
  type VSFeedSnapshot,
} from "@/lib/contract";
import { mergePendingVS } from "@/lib/pending-vs";
import {
  applyExploreFilters,
  DEFAULT_EXPLORE_FILTERS,
  MIN_STAKE_OPTIONS,
  normalizeExploreMinStake,
  type ExploreSort,
} from "@/lib/exploreFilters";
import type {
  ChallengeOpportunitiesResponse,
  ChallengeOpportunity,
} from "@/lib/claimDrafts";
import { EXPLORE_PRIMARY_CATEGORY_ROW } from "@/lib/explorePrimaryCategories";
import { useExploreFilterState } from "@/hooks/useExploreFilterState";
import PageTransition, { AnimatedItem } from "@/components/PageTransition";
import { ArenaCardSkeleton } from "@/components/ui";
import ArenaCard from "@/components/ArenaCard";
import MarketCardGrid from "@/components/MarketCardGrid";
import EmptyState from "@/components/EmptyState";
import ExploreArenaEmptyState from "@/components/explorer/ExploreArenaEmptyState";
import ExploreFilteredEmptyState from "@/components/explorer/ExploreFilteredEmptyState";
import { ChevronDown, ListFilter, RefreshCw, Search, X } from "lucide-react";
import ChallengeOpportunityCard from "@/components/explorer/ChallengeOpportunityCard";
import { BlueprintHeading } from "@/components/BlueprintGrid";
import CacheFreshnessPill from "@/components/CacheFreshnessPill";
import StaleIndexWarning from "@/components/StaleIndexWarning";
import type { VSCacheFreshness } from "@/lib/vs-freshness";

const SECONDS_PER_DAY = 86_400;

const filterPillBase =
  "shrink-0 rounded border px-4 py-2 font-display text-xs font-bold uppercase tracking-tight transition-[color,border-color,background-color] focus-ring";
const filterPillActive = "border-pv-emerald/50 bg-pv-emerald text-pv-bg";
const filterPillInactive =
  "border-pv-ink/[0.15] bg-transparent text-pv-muted hover:border-pv-ink/[0.28] hover:text-pv-text";

type ArenaViewMode = "open" | "ai" | "closed";

function getOpportunitySearchBlob(opportunity: ChallengeOpportunity) {
  return [
    opportunity.candidate.claimText,
    opportunity.sourceSummary,
    opportunity.candidate.settlementRule,
    opportunity.candidate.category,
    opportunity.candidate.primaryResolutionSource,
  ]
    .join(" ")
    .toLowerCase();
}

function getOpportunityDeadlineValue(opportunity: ChallengeOpportunity) {
  const time = new Date(opportunity.candidate.deadlineAt).getTime();
  return Number.isFinite(time) ? time : Number.MAX_SAFE_INTEGER;
}

function sortOpportunities(
  opportunities: ChallengeOpportunity[],
  sort: ExploreSort
) {
  const next = [...opportunities];

  if (sort === "expiring") {
    return next.sort(
      (a, b) => getOpportunityDeadlineValue(a) - getOpportunityDeadlineValue(b)
    );
  }

  if (sort === "strength" || sort === "highest") {
    return next.sort((a, b) => {
      if (b.candidate.confidenceScore !== a.candidate.confidenceScore) {
        return b.candidate.confidenceScore - a.candidate.confidenceScore;
      }
      return b.claimStrengthScore - a.claimStrengthScore;
    });
  }

  return next;
}

function IntelligenceDossierSkeleton() {
  return (
    <div className="h-full rounded-2xl border border-pv-ink/[0.1] bg-pv-ink/[0.03] p-4 backdrop-blur-xl">
      <div className="mb-3 grid grid-cols-1 gap-2 sm:grid-cols-3 sm:gap-3">
        <div className="h-3 rounded bg-pv-ink/[0.08]" />
        <div className="h-3 rounded bg-pv-ink/[0.08]" />
        <div className="h-3 rounded bg-pv-ink/[0.08]" />
      </div>
      <div className="mb-3 space-y-2">
        <div className="h-5 w-5/6 rounded bg-pv-ink/[0.08]" />
        <div className="h-5 w-3/4 rounded bg-pv-ink/[0.08]" />
      </div>
      <div className="mb-3 grid grid-cols-1 gap-2 rounded-2xl border border-pv-ink/[0.06] bg-black/20 p-3 sm:grid-cols-2">
        <div className="space-y-2">
          <div className="h-3 w-1/2 rounded bg-pv-ink/[0.08]" />
          <div className="h-3 rounded bg-pv-ink/[0.08]" />
        </div>
        <div className="space-y-2">
          <div className="h-3 w-1/2 rounded bg-pv-ink/[0.08]" />
          <div className="h-3 rounded bg-pv-ink/[0.08]" />
        </div>
        <div className="space-y-2">
          <div className="h-3 w-1/2 rounded bg-pv-ink/[0.08]" />
          <div className="h-3 rounded bg-pv-ink/[0.08]" />
        </div>
        <div className="space-y-2">
          <div className="h-3 w-1/2 rounded bg-pv-ink/[0.08]" />
          <div className="h-3 rounded bg-pv-ink/[0.08]" />
        </div>
      </div>
      <div className="flex gap-2">
        <div className="h-11 flex-1 rounded-lg bg-pv-ink/[0.08]" />
        <div className="h-11 w-36 rounded-lg bg-pv-ink/[0.08]" />
      </div>
    </div>
  );
}

export default function ExploreClient() {
  const { filters, updateFilters, resetFilters } = useExploreFilterState();
  const { address } = useWallet();
  const locale = useLocale();
  const [allVS, setAllVS] = useState<VSData[]>([]);
  const [opportunities, setOpportunities] = useState<ChallengeOpportunity[]>([]);
  const [vsFreshness, setVsFreshness] = useState<VSCacheFreshness | null>(null);
  const [loading, setLoading] = useState(true);
  const [opportunitiesLoading, setOpportunitiesLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const [quickFilterMenuOpen, setQuickFilterMenuOpen] = useState(false);
  const [minDraft, setMinDraft] = useState("");
  const [activeView, setActiveView] = useState<ArenaViewMode>("open");
  const [, startViewTransition] = useTransition();
  const sortMenuRef = useRef<HTMLDivElement>(null);
  const quickFilterMenuRef = useRef<HTMLDivElement>(null);
  const requestIdRef = useRef(0);
  const opportunitiesEnabled =
    process.env.NEXT_PUBLIC_FEATURE_SOURCE_DRAFTS === "1";

  const t = useTranslations("explore");
  const cacheT = useTranslations("cache");

  const loadExploreData = useCallback(
    async ({
      forceRefresh = false,
      showPageLoading = false,
    }: {
      forceRefresh?: boolean;
      showPageLoading?: boolean;
    } = {}) => {
      const requestId = ++requestIdRef.current;

      if (showPageLoading) {
        setLoading(true);
      }
      if (forceRefresh) {
        setRefreshing(true);
      }

      const vsPromise = getAllVSSnapshot({ forceRefresh })
        .then((results: VSFeedSnapshot) => {
          if (requestId === requestIdRef.current) {
            setAllVS(mergePendingVS(results.items));
            setVsFreshness(results.cache);
          }
        })
        .catch((error) => {
          console.error(error);
          if (requestId === requestIdRef.current && !forceRefresh) {
            setAllVS([]);
            setVsFreshness(null);
          }
        })
        .finally(() => {
          if (requestId === requestIdRef.current) {
            setLoading(false);
          }
        });

      let opportunitiesPromise: Promise<void> = Promise.resolve();

      if (!opportunitiesEnabled) {
        setOpportunities([]);
        setOpportunitiesLoading(false);
      } else {
        setOpportunitiesLoading(true);
        opportunitiesPromise = fetch(
          `/api/challenge-opportunities?locale=${locale}&limit=8`,
          {
            cache: "no-store",
          }
        )
          .then(async (response) => {
            const payload = (await response.json().catch(() => null)) as
              | ChallengeOpportunitiesResponse
              | { error?: { message?: string } }
              | null;

            if (!response.ok) {
              const errorMessage =
                payload && "error" in payload ? payload.error?.message : undefined;
              throw new Error(
                errorMessage || "Unable to load challenge opportunities"
              );
            }

            return payload as ChallengeOpportunitiesResponse;
          })
          .then((opportunityResult) => {
            if (requestId === requestIdRef.current) {
              setOpportunities(opportunityResult.items ?? []);
            }
          })
          .catch((error) => {
            console.error(error);
            if (requestId === requestIdRef.current && !forceRefresh) {
              setOpportunities([]);
            }
          })
          .finally(() => {
            if (requestId === requestIdRef.current) {
              setOpportunitiesLoading(false);
            }
          });
      }

      await Promise.allSettled([vsPromise, opportunitiesPromise]);

      if (requestId === requestIdRef.current && forceRefresh) {
        setRefreshing(false);
      }
    },
    [locale, opportunitiesEnabled]
  );

  useEffect(() => {
    void loadExploreData({ showPageLoading: true });
  }, [loadExploreData]);

  const commitMinDraft = useCallback(() => {
    const raw = minDraft.trim().replace(",", ".");
    if (raw === "") {
      updateFilters({ minStake: 0 });
      setMinDraft("");
      return;
    }
    const n = Number(raw);
    const next = normalizeExploreMinStake(n);
    updateFilters({ minStake: next });
    if (next === 0) {
      setMinDraft("");
    } else if (Number.isInteger(next)) {
      setMinDraft(String(next));
    } else {
      setMinDraft(next.toFixed(2));
    }
  }, [minDraft, updateFilters]);

  const handleMinInputChange = useCallback((value: string) => {
    const normalized = value.replace(",", ".");
    if (normalized === "") {
      setMinDraft("");
      return;
    }
    if (/^\d*\.?\d{0,2}$/.test(normalized)) {
      setMinDraft(normalized);
    }
  }, []);

  // Live arena = open/accepted markets. Participation filter decides whether to
  // show only markets I can join, only ones I've joined, or both. Joined markets
  // stay visible (with a badge) instead of vanishing once I bet.
  const openChallenges = useMemo(() => {
    const live = allVS.filter((vs) => vs.state === "open" || vs.state === "accepted");
    if (address && filters.participation === "joined") {
      return live.filter((vs) => didUserChallengeVS(vs, address));
    }
    if (address && filters.participation === "available") {
      return live.filter((vs) => isVSJoinable(vs, address));
    }
    // "all": joinable by me OR already joined (no wallet → just joinable)
    return live.filter(
      (vs) =>
        isVSJoinable(vs, address ?? undefined) ||
        (address ? didUserChallengeVS(vs, address) : false)
    );
  }, [address, allVS, filters.participation]);

  const filteredOpenChallenges = useMemo(
    () => applyExploreFilters(openChallenges, filters),
    [filters, openChallenges]
  );

  // Closed = resolved or cancelled. Sorted newest first by id.
  const closedChallenges = useMemo(
    () =>
      allVS
        .filter((vs) => vs.state === "resolved" || vs.state === "cancelled")
        .sort((a, b) => b.id - a.id),
    [allVS]
  );

  const filteredClosedChallenges = useMemo(
    () => applyExploreFilters(closedChallenges, filters),
    [filters, closedChallenges]
  );

  const filteredOpportunities = useMemo(() => {
    let next = opportunities;

    if (filters.cat !== "all") {
      next = next.filter(
        (opportunity) => opportunity.candidate.category === filters.cat
      );
    }

    const query = filters.search.trim().toLowerCase();
    if (query) {
      next = next.filter((opportunity) =>
        getOpportunitySearchBlob(opportunity).includes(query)
      );
    }

    if (filters.expiringSoon) {
      const nowTs = Math.floor(Date.now() / 1000);
      next = next.filter((opportunity) => {
        const deadlineMs = new Date(
          opportunity.candidate.deadlineAt
        ).getTime();
        if (!Number.isFinite(deadlineMs)) return false;
        const d = Math.floor(deadlineMs / 1000);
        return d > nowTs && d - nowTs <= SECONDS_PER_DAY;
      });
    }

    // `minStake` and `needsChallengers` apply only to on-chain VS (Arena Live).

    return sortOpportunities(next, filters.sort);
  }, [
    filters.cat,
    filters.expiringSoon,
    filters.search,
    filters.sort,
    opportunities,
  ]);

  const { cat, sort, search, minStake, needsChallengers, expiringSoon, underdogOnly } =
    filters;

  useEffect(() => {
    if (minStake === 0) {
      setMinDraft("");
    } else if (Number.isInteger(minStake)) {
      setMinDraft(String(minStake));
    } else {
      setMinDraft(minStake.toFixed(2));
    }
  }, [minStake]);

  const hasActiveFilters =
    cat !== DEFAULT_EXPLORE_FILTERS.cat ||
    minStake !== DEFAULT_EXPLORE_FILTERS.minStake ||
    sort !== DEFAULT_EXPLORE_FILTERS.sort ||
    search.trim().length > 0 ||
    needsChallengers !== DEFAULT_EXPLORE_FILTERS.needsChallengers ||
    expiringSoon !== DEFAULT_EXPLORE_FILTERS.expiringSoon ||
    underdogOnly !== DEFAULT_EXPLORE_FILTERS.underdogOnly ||
    filters.participation !== DEFAULT_EXPLORE_FILTERS.participation;

  /**
   * Proving Ground only narrows on category, search, and expiring window.
   * Min stake / needs challengers / sort alone do not remove dossiers from the AI list.
   */
  const hasActiveOpportunityFilters = useMemo(
    () =>
      cat !== DEFAULT_EXPLORE_FILTERS.cat ||
      search.trim().length > 0 ||
      expiringSoon,
    [cat, expiringSoon, search]
  );

  const sortOnlyOptions: { key: ExploreSort; label: string }[] = useMemo(
    () => [
      { key: "newest", label: t("newest") },
      {
        key: "highest",
        label:
          activeView === "ai"
            ? t("sortHighestConfidence")
            : t("highestStake"),
      },
      { key: "expiring", label: t("expiringSoon") },
      { key: "strength", label: t("strength") },
    ],
    [activeView, t]
  );

  const sortTriggerLabel = useMemo(
    () =>
      sortOnlyOptions.find((option) => option.key === sort)?.label ??
      sortOnlyOptions[0].label,
    [sort, sortOnlyOptions]
  );

  const quickFilterTriggerLabel = useMemo(() => {
    if (needsChallengers && expiringSoon) {
      return `${t("needsChallengers")} · ${t("expiringSoon")}`;
    }
    if (needsChallengers) return t("needsChallengers");
    if (expiringSoon) return t("expiringSoon");
    if (underdogOnly) return t("underdogOnly");
    if (sort === "strength" && !needsChallengers && !expiringSoon) {
      return t("strength");
    }
    return t("quickFilterAll");
  }, [expiringSoon, needsChallengers, sort, t, underdogOnly]);

  const quickFilterOptionSelected = (
    choice: "all" | "needs" | "soon" | "strength" | "underdog"
  ) => {
    if (choice === "all") {
      return !needsChallengers && !expiringSoon && !underdogOnly && sort !== "strength";
    }
    if (choice === "needs") return needsChallengers && !expiringSoon && !underdogOnly;
    if (choice === "soon") return expiringSoon && !needsChallengers && !underdogOnly;
    if (choice === "underdog") return underdogOnly;
    return sort === "strength" && !needsChallengers && !expiringSoon && !underdogOnly;
  };

  useEffect(() => {
    if (!sortMenuOpen && !quickFilterMenuOpen) return;

    const onDoc = (event: MouseEvent) => {
      const node = event.target as Node;
      if (
        sortMenuRef.current?.contains(node) ||
        quickFilterMenuRef.current?.contains(node)
      ) {
        return;
      }
      setSortMenuOpen(false);
      setQuickFilterMenuOpen(false);
    };

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSortMenuOpen(false);
        setQuickFilterMenuOpen(false);
      }
    };

    document.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey);

    return () => {
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey);
    };
  }, [quickFilterMenuOpen, sortMenuOpen]);

  const switchView = useCallback(
    (nextView: ArenaViewMode) => {
      startViewTransition(() => {
        if (nextView === "ai") {
          updateFilters({ needsChallengers: false });
        }
        setActiveView(nextView);
      });
    },
    [startViewTransition, updateFilters]
  );

  const scrollToBand = useCallback((id: string) => {
    if (typeof document === "undefined") return;
    const target = document.getElementById(id);
    target?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  const activeCountLabel =
    activeView === "open"
      ? t("available", { count: filteredOpenChallenges.length })
      : activeView === "closed"
        ? `${filteredClosedChallenges.length} settled`
        : t("aiSignalsCount", { count: filteredOpportunities.length });

  const activeBandCopy =
    activeView === "open"
      ? {
          title: t("openChallengesBandTitle"),
          hint: t("openChallengesBandHint"),
        }
      : activeView === "closed"
        ? {
            title: "Closed challenges",
            hint: "Markets the oracle has settled or refunded. Each card opens to the on-chain settlement receipt.",
          }
        : {
            title: t("aiOpportunitiesBandTitle"),
            hint: t("aiOpportunitiesBandHint"),
          };

  const renderClosedChallenges = () => {
    if (loading) {
      return (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <ArenaCardSkeleton />
          <ArenaCardSkeleton />
          <ArenaCardSkeleton />
        </div>
      );
    }

    if (filteredClosedChallenges.length === 0) {
      return (
        <ExploreArenaEmptyState
          eyebrow="No settled markets yet"
          title="The oracle hasn't closed any claims here"
          description="Settled claims appear once the deadline passes and the oracle posts a verdict on chain."
          ctaLabel="Open a challenge"
          ctaHref="/vs/create"
        />
      );
    }

    return (
      <MarketCardGrid
        aria-label="Settled market cards"
        className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3"
      >
        {filteredClosedChallenges.map((vs) => (
          <motion.div
            key={vs.id}
            layout
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.22 }}
          >
            <ArenaCard
              vs={vs}
              challengersCount={getVSChallengerCount(vs)}
              viewerAddress={address}
              hideQualityPills
            />
          </motion.div>
        ))}
      </MarketCardGrid>
    );
  };

  const renderOpenChallenges = () => {
    if (loading) {
      return (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <ArenaCardSkeleton />
          <ArenaCardSkeleton />
          <ArenaCardSkeleton />
        </div>
      );
    }

    if (filteredOpenChallenges.length === 0) {
      if (hasActiveFilters) {
        return (
          <ExploreFilteredEmptyState
            eyebrow={t("noResultsEyebrow")}
            title={t("noResults")}
            description={t("noResultsDesc")}
            resetLabel={t("resetFilters")}
            onReset={resetFilters}
          />
        );
      }

      return (
        <ExploreArenaEmptyState
          eyebrow={t("openChallengesEmptyEyebrow")}
          title={t("openChallengesEmptyTitle")}
          description={t("openChallengesEmptyDesc")}
          ctaLabel={t("openChallengesEmptyCta")}
          ctaHref="/vs/create"
        />
      );
    }

    return (
      <MarketCardGrid
        aria-label="Open market cards"
        className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3"
      >
        {filteredOpenChallenges.map((vs) => (
          <motion.div
            key={vs.id}
            layout
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.22 }}
          >
            <ArenaCard
              vs={vs}
              challengersCount={getVSChallengerCount(vs)}
              viewerAddress={address}
              hideQualityPills={false}
            />
          </motion.div>
        ))}
      </MarketCardGrid>
    );
  };

  const renderAiOpportunities = () => {
    if (!opportunitiesEnabled) {
      return (
        <EmptyState
          title={t("aiOpportunitiesDisabledTitle")}
          description={t("aiOpportunitiesDisabledDesc")}
        />
      );
    }

    if (opportunitiesLoading) {
      return (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <IntelligenceDossierSkeleton />
          <IntelligenceDossierSkeleton />
          <IntelligenceDossierSkeleton />
          <IntelligenceDossierSkeleton />
        </div>
      );
    }

    if (filteredOpportunities.length === 0) {
      if (hasActiveOpportunityFilters) {
        return (
          <ExploreFilteredEmptyState
            eyebrow={t("noResultsEyebrow")}
            title={t("noResults")}
            description={t("noResultsDesc")}
            resetLabel={t("resetFilters")}
            onReset={resetFilters}
          />
        );
      }
      return (
        <EmptyState
          title={t("aiOpportunitiesEmptyTitle")}
          description={t("aiOpportunitiesEmptyDesc")}
        />
      );
    }

    return (
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {filteredOpportunities.map((opportunity) => (
          <motion.div
            key={opportunity.id}
            layout
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.2 }}
          >
            <ChallengeOpportunityCard opportunity={opportunity} />
          </motion.div>
        ))}
      </div>
    );
  };

  return (
    <PageTransition>
      <div className="mb-8">
        <BlueprintHeading>{t("title")}</BlueprintHeading>
        {activeView !== "ai" ? (
          <div className="mt-3">
            <CacheFreshnessPill freshness={vsFreshness} />
          </div>
        ) : null}
      </div>

      {activeView !== "ai" ? (
        <StaleIndexWarning
          freshness={vsFreshness}
          refreshing={refreshing}
          onRefresh={() => void loadExploreData({ forceRefresh: true })}
        />
      ) : null}

      {/* z-20: filter dropdowns (absolute z-40) must stack above #arena-content — Framer
          motion siblings create stacking contexts; later DOM order was painting cards on top. */}
      <AnimatedItem className="relative z-20">
        <section id="arena-controls" className="mb-8" aria-label={t("filtersAriaLabel")}>
          <div className="border border-pv-border/25 bg-pv-surface p-5 sm:p-6">
            <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
              <div className="space-y-2">
                <p className="font-mono text-[10px] font-bold uppercase tracking-[0.22em] text-pv-muted">
                  {activeView === "open"
                    ? t("openChallengesTab")
                    : t("aiOpportunitiesTab")}
                </p>
                <div>
                  <h2 className="font-display text-xl font-bold uppercase tracking-tight text-pv-text sm:text-2xl">
                    {activeBandCopy.title}
                  </h2>
                  <p className="mt-1 max-w-2xl text-sm leading-relaxed text-pv-muted">
                    {activeBandCopy.hint}
                  </p>
                </div>
              </div>

              <div className="inline-flex w-full flex-col gap-2 border border-pv-border/15 bg-pv-bg p-2 sm:w-auto sm:flex-row sm:items-center">
                <button
                  type="button"
                  onClick={() => switchView("open")}
                  aria-pressed={activeView === "open"}
                  className={`flex min-h-[52px] flex-1 items-center justify-between gap-3 px-4 py-3 text-left transition-all duration-200 sm:min-w-[240px] ${
                    activeView === "open"
                      ? "border border-pv-emerald/40 bg-pv-emerald/[0.18]"
                      : "border border-transparent bg-transparent hover:border-pv-ink/[0.08] hover:bg-pv-ink/[0.03]"
                  }`}
                >
                  <span className="font-mono text-[11px] font-bold uppercase tracking-[0.2em] text-pv-text">
                    {t("openChallengesTab")}
                  </span>
                  <span
                    className={`rounded-full px-2.5 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.14em] ${
                      activeView === "open"
                        ? "bg-pv-emerald text-pv-bg"
                        : "border border-pv-ink/[0.12] bg-black/20 text-pv-muted"
                    }`}
                  >
                    {filteredOpenChallenges.length}
                  </span>
                </button>

                <button
                  type="button"
                  onClick={() => switchView("ai")}
                  aria-pressed={activeView === "ai"}
                  className={`flex min-h-[52px] flex-1 items-center justify-between gap-3 px-4 py-3 text-left transition-all duration-200 sm:min-w-[240px] ${
                    activeView === "ai"
                      ? "border border-pv-emerald/40 bg-pv-emerald/[0.18]"
                      : "border border-transparent bg-transparent hover:border-pv-ink/[0.08] hover:bg-pv-ink/[0.03]"
                  }`}
                >
                  <span className="font-mono text-[11px] font-bold uppercase tracking-[0.2em] text-pv-text">
                    {t("aiOpportunitiesTab")}
                  </span>
                  <span
                    className={`rounded-full px-2.5 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.14em] ${
                      activeView === "ai"
                        ? "bg-pv-emerald text-pv-bg"
                        : "border border-pv-ink/[0.12] bg-black/20 text-pv-muted"
                    }`}
                  >
                    {filteredOpportunities.length}
                  </span>
                </button>

                <button
                  type="button"
                  onClick={() => switchView("closed")}
                  aria-pressed={activeView === "closed"}
                  className={`flex min-h-[52px] flex-1 items-center justify-between gap-3 px-4 py-3 text-left transition-all duration-200 sm:min-w-[240px] ${
                    activeView === "closed"
                      ? "border border-pv-emerald/40 bg-pv-emerald/[0.18]"
                      : "border border-transparent bg-transparent hover:border-pv-ink/[0.08] hover:bg-pv-ink/[0.03]"
                  }`}
                >
                  <span className="font-mono text-[11px] font-bold uppercase tracking-[0.2em] text-pv-text">
                    Closed
                  </span>
                  <span
                    className={`rounded-full px-2.5 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.14em] ${
                      activeView === "closed"
                        ? "bg-pv-emerald text-pv-bg"
                        : "border border-pv-ink/[0.12] bg-black/20 text-pv-muted"
                    }`}
                  >
                    {filteredClosedChallenges.length}
                  </span>
                </button>
              </div>
            </div>

            <div className="mt-4 border border-pv-border/15 bg-pv-bg p-5 sm:p-6">
              <div className="grid grid-cols-2 gap-3 gap-y-4 lg:grid-cols-12 lg:items-end lg:gap-4 xl:gap-5">
              <div
                className="relative col-span-1 min-w-0 lg:col-span-2"
                ref={sortMenuRef}
              >
                <label
                  id="explore-sort-label"
                  htmlFor="explore-sort-trigger"
                  className="label"
                >
                  {t("sortBy")}
                </label>
                <button
                  type="button"
                  id="explore-sort-trigger"
                  aria-label={t("sortSelectAria")}
                  aria-expanded={sortMenuOpen}
                  aria-haspopup="listbox"
                  aria-controls="explore-sort-listbox"
                  onClick={() => {
                    setQuickFilterMenuOpen(false);
                    setSortMenuOpen((open) => !open);
                  }}
                  className="input flex h-11 min-h-[44px] w-full cursor-pointer items-center justify-between gap-2 bg-pv-bg py-0 pr-3 text-left font-body text-sm text-pv-text transition-[border-color,box-shadow] hover:border-pv-ink/[0.14]"
                >
                  <span className="min-w-0 truncate">{sortTriggerLabel}</span>
                  <ChevronDown
                    size={18}
                    className={`shrink-0 text-pv-muted transition-transform duration-200 ${
                      sortMenuOpen ? "rotate-180" : ""
                    }`}
                    aria-hidden
                  />
                </button>
                <AnimatePresence>
                  {sortMenuOpen ? (
                    <motion.div
                      key="explore-sort-listbox"
                      id="explore-sort-listbox"
                      role="listbox"
                      aria-labelledby="explore-sort-label"
                      initial={{ opacity: 0, y: -6 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -4 }}
                      transition={{ duration: 0.16, ease: [0.25, 0.46, 0.45, 0.94] }}
                      className="absolute left-0 top-full z-[100] mt-1.5 w-max min-w-full max-w-[min(22rem,calc(100vw-2rem))] overflow-hidden rounded border border-pv-ink/[0.1] bg-pv-bg py-1 shadow-[0_16px_48px_-12px_rgba(0,0,0,0.85)]"
                    >
                      {sortOnlyOptions.map(({ key, label }) => (
                        <button
                          key={key}
                          type="button"
                          role="option"
                          aria-selected={sort === key}
                          onClick={() => {
                            updateFilters({ sort: key });
                            setSortMenuOpen(false);
                          }}
                          className={`flex w-full items-center px-4 py-2.5 text-left font-body text-sm transition-colors ${
                            sort === key
                              ? "bg-pv-emerald/[0.12] font-medium text-pv-emerald"
                              : "text-pv-muted hover:bg-pv-ink/[0.05] hover:text-pv-text"
                          }`}
                        >
                          {label}
                        </button>
                      ))}
                    </motion.div>
                  ) : null}
                </AnimatePresence>
              </div>

              <div
                className="relative col-span-1 min-w-0 lg:col-span-2"
                ref={quickFilterMenuRef}
              >
                <label
                  id="explore-quick-filter-label"
                  htmlFor="explore-quick-filter-trigger"
                  className="label"
                >
                  {t("quickFilterLabel")}
                </label>
                <button
                  type="button"
                  id="explore-quick-filter-trigger"
                  aria-label={t("quickFilterSelectAria")}
                  aria-expanded={quickFilterMenuOpen}
                  aria-haspopup="listbox"
                  aria-controls="explore-quick-filter-listbox"
                  onClick={() => {
                    setSortMenuOpen(false);
                    setQuickFilterMenuOpen((open) => !open);
                  }}
                  className="input flex h-11 min-h-[44px] w-full cursor-pointer items-center justify-between gap-2 bg-pv-bg py-0 pr-3 text-left font-body text-sm text-pv-text transition-[border-color,box-shadow] hover:border-pv-ink/[0.14]"
                >
                  <span className="min-w-0 truncate">
                    {quickFilterTriggerLabel}
                  </span>
                  <ChevronDown
                    size={18}
                    className={`shrink-0 text-pv-muted transition-transform duration-200 ${
                      quickFilterMenuOpen ? "rotate-180" : ""
                    }`}
                    aria-hidden
                  />
                </button>
                <AnimatePresence>
                  {quickFilterMenuOpen ? (
                    <motion.div
                      key="explore-quick-filter-listbox"
                      id="explore-quick-filter-listbox"
                      role="listbox"
                      aria-labelledby="explore-quick-filter-label"
                      initial={{ opacity: 0, y: -6 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -4 }}
                      transition={{ duration: 0.16, ease: [0.25, 0.46, 0.45, 0.94] }}
                      className="absolute left-0 top-full z-[100] mt-1.5 w-max min-w-full max-w-[min(22rem,calc(100vw-2rem))] overflow-hidden rounded border border-pv-ink/[0.1] bg-pv-bg py-1 shadow-[0_16px_48px_-12px_rgba(0,0,0,0.85)]"
                    >
                      <button
                        type="button"
                        role="option"
                        aria-selected={quickFilterOptionSelected("all")}
                        onClick={() => {
                          updateFilters({
                            needsChallengers: false,
                            expiringSoon: false,
                            underdogOnly: false,
                            sort: "newest",
                          });
                          setQuickFilterMenuOpen(false);
                        }}
                        className={`flex w-full items-center px-4 py-2.5 text-left font-body text-sm transition-colors ${
                          quickFilterOptionSelected("all")
                            ? "bg-pv-emerald/[0.12] font-medium text-pv-emerald"
                            : "text-pv-muted hover:bg-pv-ink/[0.05] hover:text-pv-text"
                        }`}
                      >
                        {t("quickFilterAll")}
                      </button>
                      <button
                        type="button"
                        role="option"
                        aria-disabled={activeView === "ai"}
                        disabled={activeView === "ai"}
                        title={
                          activeView === "ai"
                            ? t("quickFilterNeedsArenaOnlyHint")
                            : undefined
                        }
                        aria-selected={quickFilterOptionSelected("needs")}
                        onClick={() => {
                          if (activeView === "ai") return;
                          updateFilters({
                            needsChallengers: true,
                            expiringSoon: false,
                            underdogOnly: false,
                          });
                          setQuickFilterMenuOpen(false);
                        }}
                        className={`flex w-full items-center px-4 py-2.5 text-left font-body text-sm transition-colors ${
                          activeView === "ai"
                            ? "cursor-not-allowed opacity-45"
                            : ""
                        } ${
                          quickFilterOptionSelected("needs")
                            ? "bg-pv-emerald/[0.12] font-medium text-pv-emerald"
                            : "text-pv-muted hover:bg-pv-ink/[0.05] hover:text-pv-text"
                        }`}
                      >
                        {t("needsChallengers")}
                      </button>
                      <button
                        type="button"
                        role="option"
                        aria-selected={quickFilterOptionSelected("soon")}
                        onClick={() => {
                          updateFilters({
                            expiringSoon: true,
                            needsChallengers: false,
                            underdogOnly: false,
                            sort: "expiring",
                          });
                          setQuickFilterMenuOpen(false);
                        }}
                        className={`flex w-full items-center px-4 py-2.5 text-left font-body text-sm transition-colors ${
                          quickFilterOptionSelected("soon")
                            ? "bg-pv-emerald/[0.12] font-medium text-pv-emerald"
                            : "text-pv-muted hover:bg-pv-ink/[0.05] hover:text-pv-text"
                        }`}
                      >
                        {t("expiringSoon")}
                      </button>
                      <button
                        type="button"
                        role="option"
                        aria-selected={quickFilterOptionSelected("strength")}
                        onClick={() => {
                          updateFilters({
                            needsChallengers: false,
                            expiringSoon: false,
                            underdogOnly: false,
                            sort: "strength",
                          });
                          setQuickFilterMenuOpen(false);
                        }}
                        className={`flex w-full items-center px-4 py-2.5 text-left font-body text-sm transition-colors ${
                          quickFilterOptionSelected("strength")
                            ? "bg-pv-emerald/[0.12] font-medium text-pv-emerald"
                            : "text-pv-muted hover:bg-pv-ink/[0.05] hover:text-pv-text"
                        }`}
                      >
                        {t("strength")}
                      </button>
                      {/* Underdog is Arena-Live only: it is derived from an
                          on-chain pool, and an AI opportunity has no pool yet. */}
                      <button
                        type="button"
                        role="option"
                        aria-disabled={activeView === "ai"}
                        disabled={activeView === "ai"}
                        title={
                          activeView === "ai"
                            ? t("quickFilterNeedsArenaOnlyHint")
                            : t("underdogOnlyHint")
                        }
                        aria-selected={quickFilterOptionSelected("underdog")}
                        onClick={() => {
                          if (activeView === "ai") return;
                          updateFilters({
                            needsChallengers: false,
                            expiringSoon: false,
                            underdogOnly: true,
                            sort: "upside",
                          });
                          setQuickFilterMenuOpen(false);
                        }}
                        className={`flex w-full items-center px-4 py-2.5 text-left font-body text-sm transition-colors ${
                          activeView === "ai" ? "cursor-not-allowed opacity-45" : ""
                        } ${
                          quickFilterOptionSelected("underdog")
                            ? "bg-pv-emerald/[0.12] font-medium text-pv-emerald"
                            : "text-pv-muted hover:bg-pv-ink/[0.05] hover:text-pv-text"
                        }`}
                      >
                        {t("underdogOnly")}
                      </button>
                    </motion.div>
                  ) : null}
                </AnimatePresence>
              </div>

              <div className="col-span-1 min-w-0 w-full max-w-[7.875rem] lg:col-span-2 lg:w-3/4 lg:max-w-none lg:justify-self-start">
                <label htmlFor="explore-min-stake" className="label">
                  {t("minStake")}
                </label>
                <input
                  id="explore-min-stake"
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  placeholder={t("minStakePlaceholder")}
                  aria-label={t("minStakeInputAria")}
                  title={
                    activeView === "ai" ? t("minStakeArenaOnlyHint") : undefined
                  }
                  disabled={activeView === "ai"}
                  value={minDraft}
                  onChange={(event) => handleMinInputChange(event.target.value)}
                  onBlur={commitMinDraft}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.currentTarget.blur();
                    }
                  }}
                  className={`input h-11 min-h-[44px] w-full max-w-full bg-pv-bg py-2.5 font-mono text-sm tabular-nums ${
                    activeView === "ai"
                      ? "cursor-not-allowed opacity-50"
                      : ""
                  }`}
                />
              </div>

              <div className="col-span-2 flex min-w-0 flex-col gap-3 lg:col-span-6 lg:flex-row lg:items-end lg:gap-3">
                <div className="flex min-w-0 w-full flex-col lg:flex-1">
                  <label htmlFor="explore-search" className="label">
                    {t("searchHeading")}
                  </label>
                  <div className="relative min-w-0 w-full">
                    <Search
                      size={16}
                      className="pointer-events-none absolute left-3 top-1/2 z-[1] -translate-y-1/2 text-pv-muted"
                      aria-hidden
                    />
                    <input
                      id="explore-search"
                      type="text"
                      inputMode="search"
                      enterKeyHint="search"
                      autoComplete="off"
                      placeholder={t("searchMarketsPlaceholder")}
                      value={search}
                      onChange={(event) =>
                        updateFilters({ search: event.target.value })
                      }
                      className={`input h-11 min-h-[44px] bg-pv-bg py-2.5 pl-10 font-body text-sm ${
                        search ? "pr-11" : ""
                      }`}
                    />
                    {search ? (
                      <button
                        type="button"
                        className="absolute right-2 top-1/2 z-[1] flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-md text-pv-muted transition-colors hover:bg-pv-ink/[0.06] hover:text-pv-text focus-ring"
                        onClick={() => updateFilters({ search: "" })}
                        aria-label={t("clearSearch")}
                      >
                        <X size={16} strokeWidth={2} />
                      </button>
                    ) : null}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setAdvancedOpen((open) => !open)}
                  aria-expanded={advancedOpen}
                  className="flex h-11 min-h-[44px] w-full shrink-0 items-center justify-center gap-2 rounded border border-pv-ink/[0.1] bg-pv-bg px-5 font-display text-[11px] font-bold uppercase tracking-[0.18em] text-pv-text transition-colors hover:border-pv-emerald/30 hover:bg-pv-ink/[0.04] lg:w-auto"
                >
                  <ListFilter size={16} className="text-pv-muted" aria-hidden />
                  {t("advanced")}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    void loadExploreData({ forceRefresh: true });
                  }}
                  disabled={refreshing}
                  aria-busy={refreshing}
                  className="flex h-11 min-h-[44px] w-full shrink-0 items-center justify-center gap-2 rounded border border-pv-ink/[0.1] bg-pv-bg px-5 font-display text-[11px] font-bold uppercase tracking-[0.18em] text-pv-text transition-colors hover:border-pv-emerald/30 hover:bg-pv-ink/[0.04] disabled:cursor-wait disabled:opacity-70 lg:w-auto"
                >
                  <RefreshCw
                    size={16}
                    className={`text-pv-muted ${refreshing ? "animate-spin" : ""}`}
                    aria-hidden
                  />
                  {refreshing ? cacheT("refreshing") : cacheT("refresh")}
                </button>
              </div>

              {address && activeView === "open" ? (
                <div className="col-span-full mt-4 border-t border-pv-ink/[0.06] pt-4">
                  <div className="grid w-full grid-cols-3 gap-2 border border-pv-border/15 bg-pv-bg p-2">
                    {(["all", "available", "joined"] as const).map((p) => (
                      <button
                        key={p}
                        type="button"
                        onClick={() => updateFilters({ participation: p })}
                        aria-pressed={filters.participation === p}
                        className={`flex min-h-[44px] w-full items-center justify-center whitespace-nowrap px-4 py-3 font-mono text-[11px] font-bold uppercase tracking-[0.2em] transition-all duration-200 ${
                          filters.participation === p
                            ? "border border-pv-emerald/40 bg-pv-emerald/[0.18] text-pv-text"
                            : "border border-transparent text-pv-muted hover:border-pv-ink/[0.08] hover:bg-pv-ink/[0.03] hover:text-pv-text"
                        }`}
                      >
                        {t(
                          p === "all"
                            ? "participationAll"
                            : p === "joined"
                              ? "participationJoined"
                              : "participationAvailable"
                        )}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>

            <motion.div
              initial={false}
              animate={{
                height: advancedOpen ? "auto" : 0,
                opacity: advancedOpen ? 1 : 0,
              }}
              transition={{
                height: { duration: 0.34, ease: [0.25, 0.46, 0.45, 0.94] },
                opacity: { duration: 0.22, ease: [0.25, 0.1, 0.25, 1] },
              }}
              className={`overflow-hidden ${!advancedOpen ? "pointer-events-none" : ""}`}
              aria-hidden={!advancedOpen}
            >
              <div className="mt-6 border-t border-pv-ink/[0.06] pt-6">
                <div className="grid grid-cols-1 gap-8 sm:grid-cols-2 sm:items-start sm:gap-x-10 sm:gap-y-6">
                  <div className="min-w-0">
                    <span className="mb-3 block font-display text-[10px] font-bold uppercase tracking-[0.22em] text-pv-muted">
                      {t("categoriesHeading")}
                    </span>
                    <div
                      className="flex flex-wrap gap-2 overflow-x-auto pb-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
                      role="group"
                      aria-label={t("category")}
                    >
                      <button
                        type="button"
                        aria-pressed={cat === "all"}
                        onClick={() => updateFilters({ cat: "all" })}
                        className={`${filterPillBase} ${
                          cat === "all" ? filterPillActive : filterPillInactive
                        }`}
                      >
                        {t("all")}
                      </button>
                      {EXPLORE_PRIMARY_CATEGORY_ROW.map(({ id, labelKey }) => (
                        <button
                          key={id}
                          type="button"
                          aria-pressed={cat === id}
                          onClick={() => updateFilters({ cat: id })}
                          className={`${filterPillBase} ${
                            cat === id ? filterPillActive : filterPillInactive
                          }`}
                        >
                          {t(labelKey)}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="min-w-0">
                    <span className="mb-3 block font-display text-[10px] font-bold uppercase tracking-[0.18em] text-pv-muted">
                      {t("advancedMinPresets")}
                    </span>
                    <div className="flex flex-wrap gap-2" role="group">
                      {MIN_STAKE_OPTIONS.map((value) => (
                        <button
                          key={value}
                          type="button"
                          aria-pressed={minStake === value}
                          disabled={activeView === "ai"}
                          title={
                            activeView === "ai"
                              ? t("minStakeArenaOnlyHint")
                              : undefined
                          }
                          onClick={() => {
                            if (activeView === "ai") return;
                            updateFilters({ minStake: value });
                            setMinDraft(value === 0 ? "" : String(value));
                          }}
                          className={`${filterPillBase} ${
                            activeView === "ai"
                              ? "cursor-not-allowed opacity-45"
                              : ""
                          } ${
                            minStake === value
                              ? filterPillActive
                              : filterPillInactive
                          }`}
                        >
                          {value === 0 ? t("any") : `${value}+ USDC`}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            </motion.div>
          </div>
          </div>
        </section>
      </AnimatedItem>

      <AnimatedItem className="relative z-0">
        <section id="arena-content" className="pb-4">
          <AnimatePresence mode="wait" initial={false}>
            {activeView === "open" && (
              <motion.div
                key="arena-open-view"
                initial={{ opacity: 0, y: 14 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                transition={{ duration: 0.22 }}
              >
                {renderOpenChallenges()}
              </motion.div>
            )}
            {activeView === "ai" && (
              <motion.div
                key="arena-ai-view"
                initial={{ opacity: 0, y: 14 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                transition={{ duration: 0.22 }}
              >
                {renderAiOpportunities()}
              </motion.div>
            )}
            {activeView === "closed" && (
              <motion.div
                key="arena-closed-view"
                initial={{ opacity: 0, y: 14 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                transition={{ duration: 0.22 }}
              >
                {renderClosedChallenges()}
              </motion.div>
            )}
          </AnimatePresence>
        </section>
      </AnimatedItem>
    </PageTransition>
  );
}
