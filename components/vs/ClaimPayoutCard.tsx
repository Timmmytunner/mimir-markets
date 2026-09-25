"use client";

/**
 * "Collect your payout" — the missing half of settlement.
 *
 * The Soroban contract settles CHALLENGERS BY PULL, and this is the only UI that
 * calls it. `resolve_claim` cannot pay everyone: a Stellar transaction is capped
 * on its ledger-entry footprint, so paying ~100 challengers does not fit in one
 * invocation (see `contracts-soroban/mimir-market/src/resolve.rs`). Instead the
 * verdict seeds `remaining_escrow` and each winner draws their share down with
 * `claim_challenger_payout`. Without a button, a won market showed "Settled." and
 * the money simply stayed in escrow.
 *
 * The creator's side is still pushed at resolution, so this card is only ever for
 * a winning challenger.
 *
 * The quote is read fresh from the contract rather than derived from the feed's
 * `potential_payout`: the fee is snapshotted per claim, the last claimant absorbs
 * the truncation dust, and `claimed` is the authoritative answer to "did I
 * already take this".
 */

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import {
  claimChallengerPayout,
  didUserChallengeVS,
  quoteChallengerPayout,
  type VSData,
} from "@/lib/contract";
import { useWallet } from "@/lib/wallet";
import { acquireTxLock } from "@/lib/tx-lock";
import { evaluateUsdcTrustlineGate } from "@/lib/usdcTrustlineGate";
import {
  UsdcTrustlineGate,
  useUsdcTrustline,
} from "@/components/wallet/UsdcTrustlineGate";
import { Button, GlassCard } from "@/components/ui";

interface Quote {
  gross: number;
  fee: number;
  net: number;
  claimed: boolean;
}

export default function ClaimPayoutCard({
  vs,
  onCollected,
}: {
  vs: VSData;
  /** Refresh the page's claim data once the pull lands. */
  onCollected?: () => void;
}) {
  const t = useTranslations("vsDetail");
  const tWallet = useTranslations("wallet");
  const { address, isConnected, signer } = useWallet();
  const trustline = useUsdcTrustline();
  const trustlineGate = evaluateUsdcTrustlineGate({
    action: "payout",
    status: trustline.status,
    loading: trustline.loading,
    stale: trustline.stale,
    isConnected,
    hasSigner: Boolean(signer),
  });

  const [quote, setQuote] = useState<Quote | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  // Only a winning challenger has anything to pull. Checked before the read so a
  // resolved market does not cost every viewer a contract simulation.
  const eligible =
    vs.state === "resolved" &&
    vs.winner_side === "challengers" &&
    Boolean(address) &&
    didUserChallengeVS(vs, address);

  const refresh = useCallback(async () => {
    if (!eligible || !address) {
      setQuote(null);
      return;
    }
    setLoading(true);
    try {
      setQuote(await quoteChallengerPayout(vs.id, address));
    } catch (err) {
      // A quote failure is not worth a toast: the card simply does not appear,
      // and the poll on the parent page will try again.
      console.warn("[ClaimPayoutCard] quote failed", err);
      setQuote(null);
    } finally {
      setLoading(false);
    }
  }, [eligible, address, vs.id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function collect() {
    if (!isConnected || !address || !signer) {
      toast.error(
        !isConnected || !address
          ? tWallet("connectWalletFirst")
          : t("walletCannotSign"),
      );
      return;
    }
    if (!trustlineGate.allowed) {
      toast.error(tWallet(trustlineGate.messageKey));
      return;
    }
    let release: (() => void) | undefined;
    try {
      release = acquireTxLock(address);
    } catch (lockErr) {
      toast.error(lockErr instanceof Error ? lockErr.message : String(lockErr));
      return;
    }
    setBusy(true);
    try {
      const result = await claimChallengerPayout(signer, vs.id);
      const hash = result.explorerTxHash || result.txHash;
      toast.success(t("claimPayoutSuccess", { net: result.netPayout.toFixed(2) }), {
        ...(hash ? { description: `Tx: ${hash.slice(0, 10)}...${hash.slice(-8)}` } : {}),
      });
      await refresh();
      onCollected?.();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error(
        /reject|denied|cancel/i.test(message)
          ? t("claimPayoutRejected")
          : message || t("claimPayoutError"),
      );
    } finally {
      setBusy(false);
      release?.();
    }
  }

  if (!eligible) return null;

  if (loading && !quote) {
    return (
      <GlassCard glass className="!rounded-2xl border border-pv-emerald/20 text-center">
        <p className="text-sm text-pv-muted">{t("claimPayoutChecking")}</p>
      </GlassCard>
    );
  }

  if (!quote) return null;

  if (quote.claimed) {
    return (
      <GlassCard glass className="!rounded-2xl border border-pv-ink/[0.12] text-center">
        <p className="text-sm text-pv-muted">{t("claimPayoutCollected")}</p>
      </GlassCard>
    );
  }

  // A resolved-and-unclaimed quote of zero means this challenger lost the market
  // even though their side won (a partial-fill edge in fixed-odds mode), so there
  // is nothing to offer and no point saying so loudly.
  if (quote.net <= 0) return null;

  return (
    <GlassCard glass className="!rounded-2xl border border-pv-emerald/35">
      <UsdcTrustlineGate trustline={trustline} className="mb-3" />
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-pv-text">{t("claimPayoutTitle")}</div>
          <p className="mt-1 text-sm text-pv-muted">{t("claimPayoutHint")}</p>
          <p className="mt-1 font-mono text-[11px] uppercase tracking-wider text-pv-muted">
            {t("claimPayoutBreakdown", {
              gross: quote.gross.toFixed(2),
              fee: quote.fee.toFixed(2),
            })}
          </p>
        </div>
        <Button
          variant="emerald"
          onClick={collect}
          loading={busy}
          disabled={!trustlineGate.allowed}
          fullWidth={false}
        >
          {busy
            ? t("claimPayoutPending")
            : t("claimPayoutCta", { net: quote.net.toFixed(2) })}
        </Button>
      </div>
    </GlassCard>
  );
}
