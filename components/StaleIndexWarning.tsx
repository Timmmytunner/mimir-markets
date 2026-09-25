"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { useTranslations } from "next-intl";

import { isStaleIndexSnapshot, type VSCacheFreshness } from "@/lib/vs-freshness";

type StaleIndexWarningProps = {
  freshness: VSCacheFreshness | null;
  onRefresh: () => void;
  refreshing: boolean;
};

export default function StaleIndexWarning({
  freshness,
  onRefresh,
  refreshing,
}: StaleIndexWarningProps) {
  const t = useTranslations("cache");
  // Keep the initial server/client render identical; advance after hydration.
  const [nowMs, setNowMs] = useState(0);

  useEffect(() => {
    setNowMs(Date.now());
    const timer = window.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  if (!isStaleIndexSnapshot(freshness, nowMs)) return null;

  return (
    <div
      role="status"
      className="mb-6 flex flex-col gap-3 rounded-lg border border-pv-gold/40 bg-pv-gold/[0.08] px-4 py-3 text-pv-text sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="flex items-start gap-3">
        <AlertTriangle size={18} className="mt-0.5 shrink-0 text-pv-gold" aria-hidden />
        <p className="text-sm leading-relaxed">
          <span className="font-semibold">{t("staleWarningTitle")}</span>{" "}
          {t("staleWarningDescription")}
        </p>
      </div>
      <button
        type="button"
        onClick={onRefresh}
        disabled={refreshing}
        aria-busy={refreshing}
        className="focus-ring inline-flex min-h-[44px] shrink-0 items-center justify-center gap-2 self-start rounded border border-pv-gold/50 px-4 py-2 font-display text-xs font-bold uppercase tracking-wide transition-colors hover:bg-pv-gold/10 disabled:cursor-wait disabled:opacity-70 sm:self-auto"
      >
        <RefreshCw size={14} className={refreshing ? "animate-spin" : ""} aria-hidden />
        {refreshing ? t("refreshing") : t("refresh")}
      </button>
    </div>
  );
}
