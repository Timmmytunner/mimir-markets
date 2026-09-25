"use client";

import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";

import { isStaleIndexSnapshot, type VSCacheFreshness } from "@/lib/vs-freshness";

const STATUS_CLASSES: Record<string, string> = {
  live: "border-pv-emerald/25 bg-pv-emerald/[0.08] text-pv-emerald",
  cached: "border-pv-gold/25 bg-pv-gold/[0.08] text-pv-gold",
  stale: "border-pv-danger/25 bg-pv-danger/[0.08] text-pv-danger",
};

function formatRelativeAge(ageMs: number | null, locale: string) {
  if (ageMs == null) {
    return null;
  }

  const rtf = new Intl.RelativeTimeFormat(locale, {
    numeric: "auto",
    style: "short",
  });

  const ageSeconds = Math.max(1, Math.round(ageMs / 1000));
  if (ageSeconds < 60) {
    return rtf.format(-ageSeconds, "second");
  }

  const ageMinutes = Math.round(ageSeconds / 60);
  if (ageMinutes < 60) {
    return rtf.format(-ageMinutes, "minute");
  }

  const ageHours = Math.round(ageMinutes / 60);
  if (ageHours < 24) {
    return rtf.format(-ageHours, "hour");
  }

  const ageDays = Math.round(ageHours / 24);
  return rtf.format(-ageDays, "day");
}

type CacheFreshnessPillProps = {
  freshness: VSCacheFreshness | null;
  className?: string;
};

export default function CacheFreshnessPill({
  freshness,
  className = "",
}: CacheFreshnessPillProps) {
  const locale = useLocale();
  const t = useTranslations("cache");
  const [nowMs, setNowMs] = useState(0);

  useEffect(() => {
    setNowMs(Date.now());
    const timer = window.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  if (!freshness) {
    return null;
  }

  const status = isStaleIndexSnapshot(freshness, nowMs) ? "stale" : freshness.status;
  const updatedAtMs = freshness.lastUpdatedAt ? Date.parse(freshness.lastUpdatedAt) : NaN;
  const ageMs = Number.isFinite(updatedAtMs) && nowMs > 0
    ? Math.max(0, nowMs - updatedAtMs)
    : freshness.ageMs;
  const relativeAge = formatRelativeAge(ageMs, locale);
  const title = freshness.lastUpdatedAt
    ? `${t("label")}: ${t(status)} | ${t(
        freshness.source === "contract" ? "sourceContract" : "sourceIndex"
      )} | ${freshness.lastUpdatedAt}`
    : `${t("label")}: ${t("unknown")}`;

  return (
    <span
      title={title}
      className={`inline-flex items-center gap-2 rounded-full border px-2.5 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.16em] ${STATUS_CLASSES[status] ?? STATUS_CLASSES.stale} ${className}`.trim()}
    >
      <span
        className="h-1.5 w-1.5 rounded-full"
        style={{ background: "currentColor" }}
        aria-hidden
      />
      <span>{t(status)}</span>
      {relativeAge ? (
        <span className="normal-case tracking-normal text-current/75">{relativeAge}</span>
      ) : null}
    </span>
  );
}
