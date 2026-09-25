"use client";

import { useMemo } from "react";
import { useLocale, useTranslations } from "next-intl";
import { ExternalLink, Receipt } from "lucide-react";

import { AddressChip } from "@/components/ui/AddressChip";
import { formatDeadline } from "@/lib/constants";
import { formatUsdc } from "@/lib/money";
import {
  buildSettlementReceipt,
  settlementReceiptShowsFields,
  type SettlementReceiptInput,
  type SettlementReceiptView,
} from "@/lib/settlementReceipt";

type SettlementReceiptProps = SettlementReceiptInput & {
  className?: string;
};

function outcomeLabel(
  view: SettlementReceiptView,
  t: ReturnType<typeof useTranslations<"settlement">>,
): string {
  if (view.outcome === "none") {
    return t("receiptOutcomeNone");
  }
  return t(`outcomes.${view.outcome}`);
}

const STATUS_CLASSES: Record<SettlementReceiptView["status"], string> = {
  loading: "border-pv-border/50 bg-pv-surface2/40 text-pv-muted",
  invalid: "border-pv-border/50 bg-pv-surface2/40 text-pv-muted",
  stale: "border-pv-danger/35 bg-pv-danger/[0.08] text-pv-danger",
  disconnected: "border-amber-400/35 bg-amber-400/[0.10] text-amber-300",
  dependency_failure: "border-amber-400/35 bg-amber-400/[0.10] text-amber-300",
  ready: "border-pv-emerald/30 bg-pv-emerald/[0.08] text-pv-emerald",
};

export default function SettlementReceipt({
  vs,
  freshness = null,
  loading = false,
  disconnected = false,
  className = "",
}: SettlementReceiptProps) {
  const t = useTranslations("settlement");
  const locale = useLocale();

  const view = useMemo(
    () => buildSettlementReceipt({ vs, freshness, loading, disconnected }),
    [vs, freshness, loading, disconnected],
  );

  const showFields = settlementReceiptShowsFields(view);

  return (
    <div
      className={`rounded-xl border border-pv-ink/[0.08] bg-pv-bg/40 p-4 ${className}`.trim()}
      data-testid="settlement-receipt"
      data-status={view.status}
      aria-live="polite"
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.16em] text-pv-text/80">
          <Receipt size={14} aria-hidden />
          {t("receipt")}
          {view.claimId != null ? (
            <span className="font-mono normal-case tracking-normal text-pv-muted">
              #{view.claimId}
            </span>
          ) : null}
        </div>
        <span
          className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-[0.14em] ${STATUS_CLASSES[view.status]}`}
        >
          <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden />
          {t(`receiptStatus.${view.statusMessageKey}`)}
        </span>
      </div>

      <p className="mb-3 text-xs leading-relaxed text-pv-muted">
        {t(`receiptStatusHint.${view.statusMessageKey}`)}
      </p>

      {showFields ? (
        <dl className="grid gap-3 sm:grid-cols-2">
          <div>
            <dt className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-pv-muted">
              {t("receiptOutcome")}
            </dt>
            <dd className="mt-1 text-sm font-semibold text-pv-text">
              {outcomeLabel(view, t)}
            </dd>
          </div>

          <div>
            <dt className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-pv-muted">
              {t("receiptConfidence")}
            </dt>
            <dd className="mt-1 text-sm font-semibold tabular-nums text-pv-text">
              {view.confidence == null
                ? t("receiptValueUnavailable")
                : `${view.confidence}%`}
            </dd>
          </div>

          <div>
            <dt className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-pv-muted">
              {t("receiptSource")}
            </dt>
            <dd className="mt-1 text-sm text-pv-text">
              {view.sourceUrl ? (
                <a
                  href={view.sourceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 text-pv-cyan hover:text-pv-text transition-colors"
                >
                  <ExternalLink size={12} aria-hidden />
                  {view.sourceHost || view.sourceUrl}
                </a>
              ) : (
                <span className="text-pv-muted">{t("unknownSource")}</span>
              )}
            </dd>
          </div>

          <div>
            <dt className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-pv-muted">
              {t("receiptDeadline")}
            </dt>
            <dd className="mt-1 text-sm tabular-nums text-pv-text">
              {view.deadlineUnix != null
                ? formatDeadline(view.deadlineUnix, locale)
                : t("receiptValueUnavailable")}
            </dd>
          </div>

          <div>
            <dt className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-pv-muted">
              {t("receiptPot")}
            </dt>
            <dd className="mt-1 text-sm font-semibold tabular-nums text-pv-text">
              {view.totalPotUsdc == null
                ? t("receiptValueUnavailable")
                : formatUsdc(view.totalPotUsdc)}
            </dd>
          </div>

          <div>
            <dt className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-pv-muted">
              {t("receiptRemainingEscrow")}
            </dt>
            <dd className="mt-1 text-sm tabular-nums text-pv-text">
              {view.remainingEscrowUsdc == null
                ? t("receiptValueUnavailable")
                : formatUsdc(view.remainingEscrowUsdc)}
            </dd>
          </div>

          {view.winnerAddress ? (
            <div className="sm:col-span-2">
              <dt className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-pv-muted">
                {t("receiptWinner")}
              </dt>
              <dd className="mt-1">
                <AddressChip address={view.winnerAddress} label={t("receiptWinner")} />
              </dd>
            </div>
          ) : null}

          {view.settlementRule ? (
            <div className="sm:col-span-2">
              <dt className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-pv-muted">
                {t("ruleApplied")}
              </dt>
              <dd className="mt-1 text-sm leading-relaxed text-pv-text/90">
                {view.settlementRule}
              </dd>
            </div>
          ) : null}
        </dl>
      ) : null}

      {view.chainBacked ? (
        <p className="mt-3 border-t border-pv-ink/[0.08] pt-3 text-[11px] leading-relaxed text-pv-muted">
          {t("receiptChainNote")}
        </p>
      ) : null}
    </div>
  );
}
