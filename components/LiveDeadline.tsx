"use client";

import { useState, useEffect, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { formatDeadline, getTimeRemaining } from "@/lib/constants";
import { useLocale } from "next-intl";

interface LiveDeadlineProps {
  deadline: number;
  /** Show the visual decay bar */
  showBar?: boolean;
  /** Phase label to display */
  phase?: "open" | "locked" | "verifying" | "proven";
  /** Show the phase badge pill next to the timer */
  showPhaseBadge?: boolean;
  /** Compact mode — no bar, smaller text */
  compact?: boolean;
  /** Override countdown text sizing/styling */
  timeClassName?: string;
  /** Hide the absolute local-timezone timestamp under the countdown */
  hideAbsolute?: boolean;
  className?: string;
}

const PHASE_CONFIG = {
  open: { label: "OPEN", color: "text-pv-cyan", bg: "bg-pv-cyan", border: "border-pv-cyan/30" },
  locked: { label: "LOCKED", color: "text-pv-fuch", bg: "bg-pv-fuch", border: "border-pv-fuch/30" },
  verifying: { label: "VERIFYING", color: "text-pv-gold", bg: "bg-pv-gold", border: "border-pv-gold/30" },
  proven: { label: "SETTLED", color: "text-pv-emerald", bg: "bg-pv-emerald", border: "border-pv-emerald/30" },
} as const;

/**
 * LiveDeadline — living countdown with visual decay bar.
 *
 * - Decaying progress bar (not just text)
 * - Absolute deadline in the user's local timezone
 * - Ticking seconds visible when < 1hr
 * - Color shifts: neutral → amber → red pulse
 * - Phase badges that animate transitions
 */
export default function LiveDeadline({
  deadline,
  showBar = true,
  phase,
  showPhaseBadge = true,
  compact = false,
  timeClassName = "",
  hideAbsolute = false,
  className = "",
}: LiveDeadlineProps) {
  const locale = useLocale();
  const countdownLocale = locale === "en" ? "en" : "es";
  const [state, setState] = useState(() => getTimeRemaining(deadline, countdownLocale));
  // Resolve timezone only after mount so SSR markup stays stable and the
  // absolute label always reflects the viewer's zone (not the server's).
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    const id = setInterval(
      () => setState(getTimeRemaining(deadline, countdownLocale)),
      1000
    );
    return () => clearInterval(id);
  }, [deadline, countdownLocale]);

  const absoluteLocal = useMemo(() => {
    if (!mounted || hideAbsolute) return "";
    return formatDeadline(deadline, countdownLocale);
  }, [mounted, hideAbsolute, deadline, countdownLocale]);

  // Calculate progress (0→1 where 1 = full time, 0 = expired)
  // Assume max range of 30 days for visual scaling
  const maxRange = 30 * 24 * 3600;
  const progress = Math.min(1, Math.max(0, state.total / maxRange));

  // Urgency levels
  const isUrgent = state.total > 0 && state.total < 3600; // < 1 hour
  const isCritical = state.total > 0 && state.total < 300; // < 5 min

  // Color based on urgency
  const timeColor = state.expired
    ? "text-pv-muted"
    : isCritical
    ? "text-pv-danger"
    : isUrgent
    ? "text-pv-gold"
    : "text-pv-text";

  const barColor = state.expired
    ? "bg-pv-muted/30"
    : isCritical
    ? "bg-pv-danger"
    : isUrgent
    ? "bg-pv-gold"
    : "bg-pv-cyan";

  const phaseConfig = phase ? PHASE_CONFIG[phase] : null;

  return (
    <div className={`flex flex-col gap-1.5 ${className}`} role="timer" aria-live="polite">
      <div className="flex items-center gap-2">
        {/* Phase badge */}
        <AnimatePresence mode="wait">
          {showPhaseBadge && phaseConfig && (
            <motion.span
              key={phase}
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.8 }}
              transition={{ duration: 0.25 }}
              className={`inline-flex items-center gap-1 px-2 py-0.5 border rounded font-mono font-bold uppercase tracking-[0.12em] ${phaseConfig.border} ${phaseConfig.color} ${
                compact ? "text-[8px]" : "text-[10px]"
              }`}
            >
              <span
                className={`w-1.5 h-1.5 rounded-full ${phaseConfig.bg} ${
                  phase === "verifying" ? "animate-phase-glow" : ""
                }`}
              />
              {phaseConfig.label}
            </motion.span>
          )}
        </AnimatePresence>

        {/* Countdown text */}
        <span
          className={`font-mono font-bold tabular-nums transition-colors duration-300 ${timeColor} ${
            compact ? "text-xs" : "text-sm"
          } ${isCritical ? "animate-phase-glow" : ""} ${timeClassName}`}
        >
          {state.text}
        </span>
      </div>

      {absoluteLocal ? (
        <time
          dateTime={new Date(deadline * 1000).toISOString()}
          className={`font-mono tabular-nums text-pv-muted ${
            compact ? "text-[9px] leading-tight" : "text-[10px] leading-snug"
          }`}
          title={absoluteLocal}
        >
          {absoluteLocal}
        </time>
      ) : null}

      {/* Decay bar */}
      {showBar && !compact && (
        <div className="relative h-1 w-full rounded-full bg-pv-ink/[0.06] overflow-hidden">
          <motion.div
            className={`absolute inset-y-0 left-0 rounded-full ${barColor} ${
              isCritical ? "animate-phase-glow" : ""
            }`}
            initial={{ width: "100%" }}
            animate={{ width: `${Math.max(progress * 100, 1)}%` }}
            transition={{ duration: 0.8, ease: [0.25, 0.46, 0.45, 0.94] }}
          />
        </div>
      )}
    </div>
  );
}
