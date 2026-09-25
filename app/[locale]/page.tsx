"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion, useInView, useReducedMotion } from "framer-motion";
import dynamic from "next/dynamic";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import {
  getAllVSSnapshot,
  getVSSingleWinnerPayout,
  getVSTotalPot,
  hasVSWinner,
  hasZeroAddressWinner,
  isVSJoinable,
  isVSMultiChallengerWin,
  type VSData,
} from "@/lib/contract";
import { ZERO_ADDRESS, shortenAddress } from "@/lib/constants";
import { mergePendingVS } from "@/lib/pending-vs";
import PageTransition, { AnimatedItem } from "@/components/PageTransition";
import { BlueprintHeading } from "@/components/BlueprintGrid";
import { Button } from "@/components/ui";
import VSCard from "@/components/VSCard";
import ArenaCard from "@/components/ArenaCard";
import MarketCardGrid from "@/components/MarketCardGrid";
import ArenaProposeCard from "@/components/ArenaProposeCard";
import SettlementArchiveSection from "@/components/SettlementArchiveSection";
import LiveStat from "@/components/LiveStat";
import { kineticContainer, kineticLetter } from "@/lib/animations/rituals";

// Canvas can't render during SSR/prerender — load client-only.
const HeroAscii = dynamic(() => import("@/components/HeroAscii"), { ssr: false });

type ParsedStat = {
  prefix: string;
  unit: string; // e.g. "M" or "B"
  suffix: string; // e.g. "+" or "%"
  target: number;
  decimals: number;
};

function parseStat(raw: string): ParsedStat | null {
  const trimmed = raw.trim();

  let prefix = "";
  let suffix = "";
  let unit = "";
  let working = trimmed;

  if (working.startsWith("$")) {
    prefix = "$";
    working = working.slice(1);
  }

  if (working.endsWith("%")) {
    suffix = "%";
    working = working.slice(0, -1);
  }

  const m = working.match(/^([0-9]+(?:\.[0-9]+)?)([MB])?(\+)?$/);
  if (!m) return null;

  const numStr = m[1];
  unit = m[2] ?? "";
  const matchSuffix = m[3] ?? "";
  suffix = suffix || matchSuffix;
  const decimals = numStr.includes(".") ? numStr.split(".")[1].length : 0;

  return {
    prefix,
    unit,
    suffix,
    target: Number.parseFloat(numStr),
    decimals,
  };
}

function formatStat(current: number, parsed: ParsedStat): string {
  const formattedNumber =
    parsed.decimals > 0 ? current.toFixed(parsed.decimals) : current.toFixed(0);

  return `${parsed.prefix}${formattedNumber}${parsed.unit}${parsed.suffix}`;
}

function AnimatedStatNumber({
  raw,
  delayMs,
}: {
  raw: string;
  delayMs: number;
}) {
  const parsed = useMemo(() => parseStat(raw), [raw]);
  const reducedMotion = useReducedMotion();

  const targetText = useMemo(
    () => (parsed ? formatStat(parsed.target, parsed) : raw),
    [parsed, raw]
  );
  const initialText = useMemo(
    () => (parsed ? formatStat(0, parsed) : raw),
    [parsed, raw]
  );

  const [display, setDisplay] = useState(initialText);
  const ref = useRef<HTMLSpanElement | null>(null);
  const startedRef = useRef(false);
  const isInView = useInView(ref, { once: true, amount: 0.05 });

  useEffect(() => {
    if (startedRef.current) return;

    if (!parsed) {
      startedRef.current = true;
      setDisplay(raw);
      return;
    }

    if (reducedMotion) {
      startedRef.current = true;
      setDisplay(targetText);
      return;
    }

    let rafId: number | null = null;
    let timeoutId: number | null = null;
    let fallbackTimeoutId: number | null = null;

    const startAnimation = () => {
      const from = 0;
      const to = parsed.target;
      const durationMs = 1700;
      const start = performance.now();

      const tick = (now: number) => {
        const t = Math.min(1, (now - start) / durationMs);
        // Ease-out cubic for a professional, smooth feel.
        const eased = 1 - Math.pow(1 - t, 3);
        const current = from + (to - from) * eased;

        setDisplay(formatStat(current, parsed));

        if (t < 1) {
          rafId = requestAnimationFrame(tick);
        } else {
          setDisplay(targetText);
        }
      };

      rafId = requestAnimationFrame(tick);
    };

    const trigger = () => {
      if (startedRef.current) return;
      startedRef.current = true;
      timeoutId = window.setTimeout(startAnimation, delayMs);
    };

    // Ideal: iniciar en el momento exacto en que entra al viewport.
    if (isInView) {
      trigger();
      return () => {
        if (timeoutId) window.clearTimeout(timeoutId);
        if (rafId) window.cancelAnimationFrame(rafId);
      };
    }

    // Fallback mobile: en algunos casos con targets inline y header fijo,
    // IntersectionObserver puede tardar o no disparar con el umbral.
    const isMobile = window.matchMedia("(max-width: 639px)").matches;
    if (!isMobile) return;

    fallbackTimeoutId = window.setTimeout(() => {
      if (startedRef.current) return;
      const el = ref.current;
      if (!el) return;

      const rect = el.getBoundingClientRect();
      const within = rect.top < window.innerHeight * 1.05 && rect.bottom > 0;
      if (!within) return;

      trigger();
    }, delayMs + 250);

    return () => {
      if (timeoutId) window.clearTimeout(timeoutId);
      if (rafId) window.cancelAnimationFrame(rafId);
      if (fallbackTimeoutId) window.clearTimeout(fallbackTimeoutId);
    };
  }, [delayMs, isInView, parsed, raw, reducedMotion, targetText]);

  useEffect(() => {
    // If the stat text changes (new locale/data), reset and allow replay once.
    startedRef.current = false;
    setDisplay(initialText);
  }, [initialText, raw]);

  return (
    <span ref={ref} aria-label={raw} className="inline-block">
      {display}
    </span>
  );
}

export default function HomePage() {
  const [allVS, setAllVS]     = useState<VSData[]>([]);
  const [loading, setLoading] = useState(true);
  const [rev, setRev] = useState<{ totalCalls: number; totalUsdc: number; uniqueSellers: number; settledUsdc: number; settledMarkets: number } | null>(null);
  const t  = useTranslations("home");
  const tStamp = useTranslations("stamp");

  const loadVS = useCallback(async ({ showPageLoading = false } = {}) => {
    if (showPageLoading) {
      setLoading(true);
    }

    try {
      const results = await getAllVSSnapshot();
      setAllVS(mergePendingVS(results.items));
    } catch (e) {
      console.error("Failed to load VS:", e);
      setAllVS([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadVS({ showPageLoading: true });
  }, [loadVS]);

  useEffect(() => {
    fetch("/api/payments/revenue")
      .then((r) => r.json())
      .then((s) => setRev({
        totalCalls: s.totalCalls, totalUsdc: s.totalUsdc, uniqueSellers: s.uniqueSellers,
        // x402 service revenue is zero until someone pays for a priced endpoint,
        // while settlement volume is real from the first resolved market. Showing
        // only the former made a working system read as a dead one.
        settledUsdc: s.market?.grossVolumeUsdc ?? 0,
        settledMarkets: s.market?.settledMarkets ?? 0,
      }))
      .catch(() => setRev(null));
  }, []);

  const openVS     = allVS.filter((v) => isVSJoinable(v));
  const resolvedVS = allVS.filter((v) => v.state === "resolved");
  const decidedResolvedVS = resolvedVS.filter((v) => hasVSWinner(v));
  const totalGenStaked = allVS.reduce((sum, vs) => sum + getVSTotalPot(vs), 0);

  const arenaGridCards = Array.from(
    new Map(
      [...openVS, ...allVS.filter((v) => v.state !== "open")].map((vs) => [vs.id, vs]),
    ).values(),
  )
    .slice(0, 5)
    .map((vs) => ({ vs, challengersCount: undefined as number | undefined }));

  const steps = [
    {
      icon: null,
      iconSrc: "/icons/handshake-logo.svg",
      title: `1. ${t("stepChallenge").toUpperCase()}`,
      description:
        "Define your terms and lock your stake in the vault. The AI starts watching.",
    },
    {
      icon: null,
      iconSrc: "/icons/letter.svg",
      title: `2. ${t("stepSend").toUpperCase()}`,
      description:
        "Broadcast your link. Call out a specific rival or open it to the public arena.",
    },
    {
      icon: null,
      iconSrc: "/icons/check-circle-logo.svg",
      title: `3. ${t("stepAccept").toUpperCase()}`,
      description:
        "Rival stakes their matching amount. Smart contract activates and locks the pool.",
    },
    {
      icon: null,
      iconSrc: "/icons/verified.svg",
      title: `4. ${t("stepProven").toUpperCase()}`,
      description:
        "Consensus validates the proof, and the winner gets paid on-chain instantly.",
    },
  ];

  return (
    <PageTransition>
      {/* Hero — Manifesto with kinetic typography + arena grid */}
      <AnimatedItem>
        <section className="relative w-full -mt-[calc(3.5rem+env(safe-area-inset-top))]">
          {/* Backdrop fills the rail column edge-to-edge and bleeds up under the
              transparent fixed navbar (rails reach the top of the page). */}
          <div className="absolute inset-y-0 left-1/2 z-0 h-full w-full max-w-[1200px] -translate-x-1/2">
            <div className="relative h-full w-full overflow-hidden">
              <HeroAscii />
              <div className="pointer-events-none absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-pv-bg via-pv-bg/35 to-transparent sm:h-32" />
              <div className="pointer-events-none absolute inset-x-0 bottom-0 h-28 bg-gradient-to-t from-pv-bg via-pv-bg/60 to-transparent sm:h-40" />
            </div>
          </div>

          {/* Text panel — shorter hero so the rest shows sooner */}
          <div className="relative z-10 mx-auto flex min-h-[68vh] w-full max-w-[1200px] items-center justify-center border-x border-pv-border/25 px-4 sm:px-6 lg:px-8 pt-[calc(3.5rem+env(safe-area-inset-top))]">
            <div className="w-full max-w-[640px] py-12 sm:py-14 lg:py-16 text-center">
              {/* Headline — 3 lines, reduced size, payoff line smaller */}
              <motion.h1
                className="mb-6 flex flex-col gap-1 text-center font-display font-bold leading-[0.92] tracking-tight text-pv-text"
                variants={kineticContainer}
                initial="hidden"
                animate="visible"
              >
                {/* Line 1: DON'T ARGUE. — single line, no wrap */}
                <span className="block overflow-hidden text-[clamp(2.6rem,7vw,4.6rem)] lg:text-[clamp(3rem,4.4vw,5rem)]">
                  <motion.span variants={kineticLetter} className="inline-block whitespace-nowrap">
                    DON&apos;T ARGUE.
                  </motion.span>
                </span>
                {/* Line 2: SETTLE. */}
                <span className="block overflow-hidden text-[clamp(2.6rem,7vw,4.6rem)] lg:text-[clamp(3rem,4.4vw,5rem)]">
                  <motion.span variants={kineticLetter} className="inline-block whitespace-nowrap">
                    SETTLE.
                  </motion.span>
                </span>
                {/* Rhythmic pause */}
                <span className="block h-2 lg:h-3" aria-hidden />
                {/* Line 3: WITH MIMIR. — smaller payoff/accent */}
                <span className="block overflow-hidden text-[clamp(2.7rem,7vw,4rem)] lg:text-[clamp(2.8rem,4.5vw,4.2rem)]">
                  <motion.span variants={kineticLetter} className="inline-block mr-[0.25em] font-medium text-pv-muted">
                    {t("emptyHeroTitleLine2Lead")}
                  </motion.span>
                  <motion.span
                    variants={kineticLetter}
                    // Themed, not white: this sits on the page background, where a
                    // hard white wordmark disappears entirely on the light palette.
                    className="inline-block italic text-pv-text drop-shadow-[0_0_18px_rgba(51,79,169,0.5)]"
                  >
                    Mimir.
                  </motion.span>
                </span>
              </motion.h1>

              <motion.p
                className="mb-5 mx-auto max-w-[460px] text-[13px] leading-relaxed text-pv-muted/90 sm:text-sm lg:text-[15px] lg:leading-7"
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.5, duration: 0.5 }}
              >
                {t("emptyHeroSubtitle")}
              </motion.p>

              <motion.div
                className="flex flex-col gap-3 sm:flex-row sm:justify-center sm:gap-4"
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.58, duration: 0.5 }}
              >
                {/* Secondary CTA — fuchsia neon */}
                <Link
                  href="/explorer"
                  className="group relative flex items-center justify-center overflow-hidden rounded-lg border border-pv-fuch/40 bg-transparent px-7 py-3.5 font-display text-[13px] font-bold uppercase tracking-[0.14em] text-pv-muted/90 transition-all duration-300 hover:border-pv-fuch/70 hover:bg-pv-fuch/[0.12] hover:text-white hover:shadow-[0_0_28px_-4px_rgba(51,79,169,0.45),inset_0_0_20px_-8px_rgba(51,79,169,0.12)]"
                >
                  <span className="absolute inset-0 opacity-0 transition-opacity duration-300 group-hover:opacity-100 bg-gradient-to-r from-pv-fuch/[0.12] via-transparent to-pv-fuch/[0.06]" />
                  <span className="relative">{t("heroExploreChallenges")}</span>
                </Link>

                {/* Primary CTA — cyan neon */}
                <Link
                  href="/vs/create"
                  className="group relative flex items-center justify-center overflow-hidden rounded-lg border border-pv-emerald/50 bg-pv-emerald/[0.15] px-7 py-3.5 font-display text-[13px] font-bold uppercase tracking-[0.14em] text-white transition-all duration-300 hover:border-pv-emerald/80 hover:bg-pv-emerald/[0.25] hover:text-white hover:shadow-[0_0_28px_-4px_rgba(51,79,169,0.5),inset_0_0_20px_-8px_rgba(51,79,169,0.15)]"
                >
                  <span className="absolute inset-0 opacity-0 transition-opacity duration-300 group-hover:opacity-100 bg-gradient-to-r from-pv-emerald/[0.18] via-transparent to-pv-emerald/[0.09]" />
                  <span className="relative">{t("heroChallengeSomeone")}</span>
                </Link>
              </motion.div>
            </div>
          </div>
        </section>
      </AnimatedItem>

      {/* Differentiator — stats strip (total / resolved / USDC staked); mismo patrón que THE PROTOCOL / LIVE ARENA */}
      <AnimatedItem>
        <div className="relative">
          <BlueprintHeading>{t("statsSectionTitle")}</BlueprintHeading>

          <div className="grid grid-cols-1 gap-px border-x border-pv-border/25 bg-pv-border/25 sm:grid-cols-3">
            <div className="p-5 sm:p-6 text-center bg-pv-bg">
              <LiveStat
                value={allVS.length}
                label={t("totalClaims")}
                labelPosition="below"
                size="lg"
                color="emerald"
                  labelClassName="text-[12px]"
                className="items-center"
              />
            </div>
            <div className="p-5 sm:p-6 text-center bg-pv-bg">
              <LiveStat
                value={resolvedVS.length}
                label={t("resolvedClaims")}
                labelPosition="below"
                size="lg"
                color="emerald"
                  labelClassName="text-[12px]"
                className="items-center"
              />
            </div>
            <div className="p-5 sm:p-6 text-center bg-pv-bg">
              <LiveStat
                value={totalGenStaked}
                label={t("genStaked")}
                labelPosition="below"
                size="lg"
                color="gold"
                suffix="USDC"
                  labelClassName="text-[12px]"
                className="items-center"
              />
            </div>
          </div>

          {/* x402 USDC nanopayment strip — live agent-to-agent earnings */}
          {rev && (
            <div className="grid grid-cols-1 gap-px border-x border-t border-pv-border/25 bg-pv-border/25 sm:grid-cols-3">
              <div className="p-5 sm:p-6 text-center bg-pv-bg">
                <LiveStat
                  value={rev.totalCalls}
                  label={t("botPayments")}
                  labelPosition="below"
                  size="lg"
                  color="cyan"
                  labelClassName="text-[12px]"
                  className="items-center"
                />
              </div>
              <div className="p-5 sm:p-6 text-center bg-pv-bg">
                <LiveStat
                  value={rev.settledUsdc > 0 ? rev.settledUsdc : rev.totalUsdc}
                  format={(n) => n.toFixed(2)}
                  label={rev.settledUsdc > 0 ? t("volumeSettled") : t("botEarned")}
                  // Agents paying agents is the part people do not believe until
                  // they see the number, so it gets its own line rather than being
                  // folded into settled volume.
                  sublabel={rev.totalCalls > 0
                    ? `${rev.totalUsdc.toFixed(3)} USDC over ${rev.totalCalls} x402 calls`
                    : undefined}
                  labelPosition="below"
                  size="lg"
                  color="gold"
                  suffix="USDC"
                  labelClassName="text-[12px]"
                  className="items-center"
                />
              </div>
              <div className="p-5 sm:p-6 text-center bg-pv-bg">
                <LiveStat
                  value={rev.uniqueSellers}
                  label={t("sellerWallets")}
                  labelPosition="below"
                  size="lg"
                  color="emerald"
                  labelClassName="text-[12px]"
                  className="items-center"
                />
              </div>
            </div>
          )}
        </div>
      </AnimatedItem>

      {/* THE PROTOCOL — layout tipo bento (inspirado en “Market Intelligence” del prototipo) */}
      <AnimatedItem>
        <div className="relative">
          <BlueprintHeading>THE PROTOCOL</BlueprintHeading>

          <div className="grid grid-cols-1 gap-px border-x border-pv-border/25 bg-pv-border/25 md:grid-cols-4 md:auto-rows-[minmax(240px,auto)] [&>*]:h-full">
            {steps.map(({ iconSrc, title, description }, index) => {
              const stepLabel = `STEP ${String(index + 1).padStart(2, "0")}`;

              const renderIcon = (sizeClass: string) =>
                iconSrc ? (
                  <span
                    className={`${sizeClass} shrink-0 bg-pv-emerald`}
                    style={{
                      WebkitMaskImage: `url(${iconSrc})`,
                      maskImage: `url(${iconSrc})`,
                      WebkitMaskRepeat: "no-repeat",
                      maskRepeat: "no-repeat",
                      WebkitMaskPosition: "center",
                      maskPosition: "center",
                      WebkitMaskSize: "contain",
                      maskSize: "contain",
                    }}
                    aria-hidden
                  />
                ) : null;

              /* Fila 1: tile destacado (2 cols) + dos compactas (1+1). Fila 2: barra ancha (4 cols). */
              if (index === 0) {
                return (
                  <div
                    key={title}
                    className="card group relative col-span-1 flex flex-col justify-between overflow-hidden border-transparent p-6 transition-all duration-200 hover:border-pv-emerald/[0.45] hover:shadow-glow-emerald sm:p-8 md:col-span-2 md:min-h-[280px]"
                  >
                    <div className="pointer-events-none absolute -right-6 -top-6 opacity-[0.06] transition-opacity group-hover:opacity-[0.1] sm:-right-10 sm:-top-10">
                      {iconSrc ? (
                        <span
                          className="block h-40 w-40 bg-pv-emerald sm:h-48 sm:w-48"
                          style={{
                            WebkitMaskImage: `url(${iconSrc})`,
                            maskImage: `url(${iconSrc})`,
                            WebkitMaskRepeat: "no-repeat",
                            maskRepeat: "no-repeat",
                            WebkitMaskPosition: "center",
                            maskPosition: "center",
                            WebkitMaskSize: "contain",
                            maskSize: "contain",
                          }}
                          aria-hidden
                        />
                      ) : null}
                    </div>
                    <div className="relative z-10 flex min-w-0 flex-1 items-start gap-4 md:items-center">
                      {renderIcon("h-12 w-12 shrink-0 sm:h-14 sm:w-14")}
                      <div className="min-w-0">
                        <div className="mb-2 font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-pv-emerald">
                          {stepLabel}
                        </div>
                        <h3 className="font-display text-xl font-bold leading-tight tracking-tight text-pv-text sm:text-2xl md:text-3xl">
                          {title.replace(/^\d+\.\s*/, "")}
                        </h3>
                        <p className="mt-2 max-w-prose text-sm leading-relaxed text-pv-muted sm:text-[15px]">
                          {description}
                        </p>
                      </div>
                    </div>
                    <div className="relative z-10 mt-6 h-px bg-gradient-to-r from-pv-emerald/40 to-transparent opacity-40" />
                    <div className="relative z-10 mt-4 flex items-center justify-between gap-3">
                      <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-pv-muted">
                        Protocol layer
                      </span>
                      <span className="font-mono text-[10px] font-bold uppercase tracking-[0.12em] text-pv-emerald">
                        Live
                      </span>
                    </div>
                  </div>
                );
              }

              if (index === 1 || index === 2) {
                return (
                  <div
                    key={title}
                    className="card group relative overflow-hidden flex flex-col justify-between border-transparent p-6 transition-all duration-200 hover:border-pv-emerald/[0.45] hover:shadow-glow-emerald sm:p-8 md:col-span-1 md:min-h-[280px]"
                  >
                    <div className="pointer-events-none absolute -right-9 -top-6 z-0 opacity-[0.06] transition-opacity group-hover:opacity-[0.1] sm:-right-13 sm:-top-10">
                      {iconSrc ? (
                        <span
                          className="block h-40 w-40 bg-pv-emerald sm:h-48 sm:w-48"
                          style={{
                            WebkitMaskImage: `url(${
                              index === 1
                                ? "/icons/user.svg"
                                : index === 2
                                  ? "/icons/thumb-up.svg"
                                  : iconSrc
                            })`,
                            maskImage: `url(${
                              index === 1
                                ? "/icons/user.svg"
                                : index === 2
                                  ? "/icons/thumb-up.svg"
                                  : iconSrc
                            })`,
                            WebkitMaskRepeat: "no-repeat",
                            maskRepeat: "no-repeat",
                            WebkitMaskPosition: "center",
                            maskPosition: "center",
                            WebkitMaskSize: "contain",
                            maskSize: "contain",
                          }}
                          aria-hidden
                        />
                      ) : null}
                    </div>
                    <div className="relative z-10">
                      <div className="mb-3 font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-pv-emerald">
                        {stepLabel}
                      </div>
                      <div className="mb-4">{renderIcon("h-10 w-10 sm:h-11 sm:w-11")}</div>
                      <h3 className="font-display text-lg font-bold leading-tight tracking-tight text-pv-text sm:text-xl">
                        {title}
                      </h3>
                    </div>
                    <p className="relative z-10 mt-4 text-sm leading-relaxed text-pv-muted sm:text-[15px]">
                      {description}
                    </p>
                  </div>
                );
              }

              /* index === 3 — barra ancha */
              return (
                <div
                  key={title}
                  className="card group relative col-span-1 overflow-hidden flex flex-col gap-6 border-transparent p-6 transition-all duration-200 hover:border-pv-emerald/[0.45] hover:shadow-glow-emerald sm:p-8 md:col-span-4 md:flex-row md:items-center md:justify-between md:gap-10"
                >
                  <div className="pointer-events-none absolute -right-9 -top-6 z-0 opacity-[0.06] transition-opacity group-hover:opacity-[0.1] sm:-right-13 sm:-top-10">
                    {iconSrc ? (
                      <span
                        className="block h-40 w-40 bg-pv-emerald sm:h-48 sm:w-48"
                        style={{
                          WebkitMaskImage: "url(/icons/verify.svg)",
                          maskImage: "url(/icons/verify.svg)",
                          WebkitMaskRepeat: "no-repeat",
                          maskRepeat: "no-repeat",
                          WebkitMaskPosition: "center",
                          maskPosition: "center",
                          WebkitMaskSize: "contain",
                          maskSize: "contain",
                        }}
                        aria-hidden
                      />
                    ) : null}
                  </div>
                  <div className="relative z-10 flex min-w-0 flex-1 items-start gap-4 md:items-center">
                    {renderIcon("h-11 w-11 shrink-0 sm:h-12 sm:w-12")}
                    <div className="min-w-0">
                      <div className="mb-2 font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-pv-emerald">
                        {stepLabel}
                      </div>
                      <h3 className="font-display text-xl font-medium tracking-tighter text-pv-text sm:text-2xl md:text-3xl">
                        {title.replace(/^\d+\.\s*/, "")}
                      </h3>
                      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-pv-muted sm:text-[15px]">
                        {description}
                      </p>
                    </div>
                  </div>
                  <div className="relative z-10 hidden h-12 w-px shrink-0 bg-pv-ink/[0.1] md:block" aria-hidden />
                  <div className="relative z-10 flex shrink-0 flex-col items-start gap-1 md:items-end md:text-right">
                    <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-pv-muted">
                      Settlement
                    </span>
                    <span className="font-display text-lg font-semibold text-pv-emerald sm:text-xl">
                      On-chain
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </AnimatedItem>

      {/* LIVE ARENA — 3x2 grid of active challenges */}
      {arenaGridCards.length > 0 && (
        <AnimatedItem>
          <div className="relative">
            <BlueprintHeading>LIVE ARENA</BlueprintHeading>

            <MarketCardGrid
              aria-label="Live arena market cards"
              className="grid grid-cols-1 gap-px border-x border-pv-border/25 bg-pv-border/25 sm:grid-cols-2 lg:grid-cols-3 [&>*]:border-0 [&>*]:h-full"
            >
              {arenaGridCards.map(({ vs, challengersCount }) => (
                <ArenaCard
                  key={vs.id}
                  vs={vs}
                  challengersCount={challengersCount}
                  archiveLabelShort={vs.id === -5}
                  hideClaimStrengthPill
                />
              ))}
              <ArenaProposeCard />
            </MarketCardGrid>
          </div>
        </AnimatedItem>
      )}

      {/* THE ARCHIVE — settlement index + terminal (inspirado en “Archive / Odds” editorial) */}
      <AnimatedItem>
        <div className="relative">
          <SettlementArchiveSection allVS={allVS} loading={loading} />
        </div>
      </AnimatedItem>

      {/* READY TO WIN CTA — blueprint framed strip, connected to neighbours */}
      <AnimatedItem>
        <div className="group relative overflow-hidden border border-pv-border/25 bg-pv-surface px-6 py-12 sm:px-10 sm:py-14 md:px-14 md:py-16">
          <div
            className="pointer-events-none absolute inset-y-0 right-0 w-1/2 opacity-[0.14] transition-opacity duration-700 group-hover:opacity-[0.22]"
            aria-hidden
          >
            <div className="h-full w-full bg-gradient-to-l from-pv-emerald/50 via-pv-emerald/10 to-transparent" />
          </div>
          <div
            className="pointer-events-none absolute -right-24 top-1/2 h-80 w-80 -translate-y-1/2 rounded-full bg-pv-emerald/20 blur-3xl"
            aria-hidden
          />

          <div className="relative z-10 flex flex-col items-start gap-8 text-left md:flex-row md:items-center md:justify-between md:gap-12">
            <div className="max-w-xl">
              <div className="mb-5 flex items-center gap-3">
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-pv-emerald opacity-40" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-pv-emerald" />
                </span>
                <span className="font-mono text-[10px] font-bold uppercase tracking-[0.22em] text-pv-muted">
                  Launch a challenge
                </span>
              </div>

              <h2 className="font-display text-[clamp(2rem,7vw,3.4rem)] font-bold leading-[0.95] tracking-tight text-pv-text">
                READY TO <span className="text-pv-emerald">WIN?</span>
              </h2>
              <p className="mt-4 max-w-[46ch] text-sm leading-relaxed text-pv-muted sm:text-base">
                Set the terms, lock your stake, and share the link. When the outcome is provable, Mimir settles it on-chain.
              </p>
            </div>

            <div className="w-full shrink-0 md:w-auto">
              <Link href="/vs/create" className="block w-full md:w-auto">
                <Button
                  variant="primary"
                  className="w-full md:w-auto px-10 py-4 font-display text-xs font-bold uppercase tracking-[0.2em]"
                >
                  CREATE A CHALLENGE
                </Button>
              </Link>
            </div>
          </div>
        </div>
      </AnimatedItem>


      

      {/* Market Explorer preview — 2 cols en desktop */}
      {openVS.length > 0 && (
        <AnimatedItem>
          <div className="relative">
            <BlueprintHeading>MARKET EXPLORER</BlueprintHeading>

            <MarketCardGrid
              aria-label="Market explorer cards"
              className="grid grid-cols-1 gap-px border-x border-pv-border/25 bg-pv-border/25 lg:grid-cols-2 [&>*]:border-0 [&>*]:h-full"
            >
              {openVS.slice(0, 4).map((vs) => (
                <VSCard key={vs.id} vs={vs} />
              ))}
            </MarketCardGrid>

            {openVS.length > 4 && (
              <Link
                href="/explorer"
                className="block w-full border-x border-pv-border/25 bg-pv-emerald/[0.06] py-3.5 text-center font-display text-sm font-bold text-pv-emerald transition-colors hover:bg-pv-emerald/[0.12]"
              >
                {t("viewAllOpen", { count: openVS.length })}
              </Link>
            )}
          </div>
        </AnimatedItem>
      )}

      {/* THE LEDGER — recently proven settlements, blueprint table */}
      {decidedResolvedVS.length > 0 && (
        <AnimatedItem>
          <div className="relative">
            <BlueprintHeading>THE LEDGER</BlueprintHeading>
            <div className="grid gap-px border-x border-pv-border/25 bg-pv-border/25">
              {decidedResolvedVS.slice(0, 6).map((vs) => {
                const payout = getVSSingleWinnerPayout(vs);
                const winnerLabel =
                  vs.winner_side === "challengers" &&
                  (isVSMultiChallengerWin(vs) || hasZeroAddressWinner(vs))
                    ? "Challengers won"
                    : tStamp("won", { address: shortenAddress(vs.winner) });

                return (
                  <Link
                    key={vs.id}
                    href={`/vs/${vs.id}`}
                    className="group flex items-center justify-between gap-4 bg-pv-bg px-5 py-4 transition-colors hover:bg-pv-surface sm:px-6"
                  >
                    <div className="flex min-w-0 items-center gap-3 sm:gap-4">
                      <span className="w-10 shrink-0 font-mono text-[11px] text-pv-muted/60">
                        #{vs.id}
                      </span>
                      <span className="hidden shrink-0 border border-pv-emerald/40 px-2 py-0.5 font-mono text-[9px] font-bold uppercase tracking-[0.18em] text-pv-emerald sm:inline-block">
                        Settled
                      </span>
                      <span className="truncate font-mono text-[13px] text-pv-text/90">
                        {winnerLabel}
                      </span>
                    </div>
                    <div className="flex shrink-0 items-center gap-3">
                      <span className="font-mono text-[13px] font-bold text-pv-gold">
                        {payout === null ? `${getVSTotalPot(vs)} USDC` : `+${payout} USDC`}
                      </span>
                      <span className="font-mono text-pv-muted/50 transition-transform duration-200 group-hover:translate-x-0.5 group-hover:text-pv-emerald">
                        →
                      </span>
                    </div>
                  </Link>
                );
              })}
            </div>
          </div>
        </AnimatedItem>
      )}
    </PageTransition>
  );
}
