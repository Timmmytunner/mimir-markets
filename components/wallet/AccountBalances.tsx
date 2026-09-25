"use client";

/**
 * Balances and pull-only claims for the connected wallet.
 *
 * Exists because the Soroban contract has two PULL paths that no screen used to
 * expose, and money with no way out is a bug, not a missing nicety:
 *
 *  - `withdraw()` — funds parked because a payout push could not be delivered
 *    (the beneficiary had no trustline at settlement time, most likely). The
 *    contract deliberately parks rather than reverting the whole settlement, so
 *    without a button here that balance is stranded.
 *  - `claim_fees()` — accrued platform / agent-owner fees. Never pushed, by
 *    design, so a fee recipient with no UI had no way to collect either.
 *
 * Both are self-authorising: the contract takes `who` as an argument and
 * `require_auth`s it, so a user can only ever pull their own.
 *
 * The card renders even at zero, with "nothing parked" rather than nothing at
 * all: someone who was told a payout failed needs to be able to come here and
 * see that it is now zero because they already pulled it.
 */

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import { claimFees, getAccruedFees, getWithdrawable, withdraw } from "@/lib/contract";
import { getUsdcBalanceUnits, unitsToUsdc } from "@/lib/usdc";
import { useWallet } from "@/lib/wallet";
import { acquireTxLock } from "@/lib/tx-lock";
import { evaluateUsdcTrustlineGate } from "@/lib/usdcTrustlineGate";
import {
  UsdcTrustlineGate,
  useUsdcTrustline,
} from "@/components/wallet/UsdcTrustlineGate";

type Action = "withdraw" | "fees" | null;

export default function AccountBalances({ className = "" }: { className?: string }) {
  const t = useTranslations("wallet");
  const { address, isConnected, signer } = useWallet();
  const trustline = useUsdcTrustline();

  const [usdc, setUsdc] = useState<number | null>(null);
  const [withdrawable, setWithdrawable] = useState(0);
  const [fees, setFees] = useState(0);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState<Action>(null);
  const trustlineGate = evaluateUsdcTrustlineGate({
    action: "withdraw",
    status: trustline.status,
    loading: trustline.loading,
    stale: trustline.stale,
    isConnected,
    hasSigner: Boolean(signer),
  });

  const load = useCallback(async () => {
    if (!address) {
      setUsdc(null);
      setWithdrawable(0);
      setFees(0);
      setLoadFailed(false);
      return;
    }
    setUsdc(null);
    setWithdrawable(0);
    setFees(0);
    setLoadFailed(false);
    try {
      const [balanceUnits, parked, accrued] = await Promise.all([
        getUsdcBalanceUnits(address),
        getWithdrawable(address),
        getAccruedFees(address),
      ]);
      setUsdc(balanceUnits === null ? null : unitsToUsdc(balanceUnits));
      setWithdrawable(parked);
      setFees(accrued);
      setLoadFailed(false);
    } catch (err) {
      console.warn("[AccountBalances] read failed", err);
      setLoadFailed(true);
    }
  }, [address]);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(action: Exclude<Action, null>) {
    if (!isConnected || !address || !signer) {
      toast.error(!isConnected || !address ? t("connectWalletFirst") : t("cannotSign"));
      return;
    }
    if (!trustlineGate.allowed) {
      toast.error(t(trustlineGate.messageKey));
      return;
    }
    let release: (() => void) | undefined;
    try {
      release = acquireTxLock(address);
    } catch (lockErr) {
      toast.error(lockErr instanceof Error ? lockErr.message : String(lockErr));
      return;
    }
    setBusy(action);
    try {
      const result = action === "withdraw" ? await withdraw(signer) : await claimFees(signer);
      const amount = result.amount.toFixed(2);
      toast.success(
        action === "withdraw" ? t("withdrawSuccess", { amount }) : t("claimFeesSuccess", { amount }),
      );
      await load();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error(/reject|denied|cancel/i.test(message) ? t("pending") : message);
    } finally {
      setBusy(null);
      release?.();
    }
  }

  if (!address) return null;

  const row =
    "flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-t border-pv-ink/[0.08] py-3 first:border-t-0 first:pt-0";
  const label = "font-mono text-[10px] uppercase tracking-wider text-pv-muted";
  const value = "font-mono text-sm font-bold tabular-nums text-pv-text";

  return (
    <section
      className={`border border-pv-ink/[0.12] bg-pv-surface/40 p-4 sm:p-5 ${className}`}
      aria-label={t("balancesTitle")}
    >
      <h3 className="font-display text-sm font-bold text-pv-text">{t("balancesTitle")}</h3>
      <p className="mt-1 text-[12px] leading-relaxed text-pv-muted">{t("balancesHint")}</p>

      <UsdcTrustlineGate
        trustline={trustline}
        className="mt-3"
        onReady={() => void load()}
      />

      {loadFailed ? (
        <p className="mt-3 text-[12px] text-pv-danger">{t("loadFailed")}</p>
      ) : (
        <div className="mt-3">
          <div className={row}>
            <span className={label}>{t("usdcBalance")}</span>
            {/* Null is not zero: null means this account holds no USDC trustline
                at all, which the gate above is already asking them to fix. */}
            <span className={value}>{usdc === null ? "—" : `${usdc.toFixed(2)} USDC`}</span>
          </div>

          <div className={row}>
            <span className={label}>{t("withdrawable")}</span>
            <span className="flex items-center gap-3">
              <span className={value}>{withdrawable.toFixed(2)} USDC</span>
              <button
                type="button"
                onClick={() => void run("withdraw")}
                disabled={withdrawable <= 0 || busy !== null || !trustlineGate.allowed}
                className="btn-compact-primary px-3 py-1.5 text-[12px] disabled:opacity-40"
              >
                {busy === "withdraw"
                  ? t("pending")
                  : withdrawable <= 0
                    ? t("withdrawNone")
                    : t("withdrawCta", { amount: withdrawable.toFixed(2) })}
              </button>
            </span>
          </div>

          <div className={row}>
            <span className={label}>{t("accruedFees")}</span>
            <span className="flex items-center gap-3">
              <span className={value}>{fees.toFixed(2)} USDC</span>
              <button
                type="button"
                onClick={() => void run("fees")}
                disabled={fees <= 0 || busy !== null || !trustlineGate.allowed}
                className="btn-compact-primary px-3 py-1.5 text-[12px] disabled:opacity-40"
              >
                {busy === "fees"
                  ? t("pending")
                  : fees <= 0
                    ? t("claimFeesNone")
                    : t("claimFeesCta", { amount: fees.toFixed(2) })}
              </button>
            </span>
          </div>
        </div>
      )}
    </section>
  );
}
