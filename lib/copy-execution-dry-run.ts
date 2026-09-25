import { evaluateCopy, type CopyExecutionContext, type CopyPermission, type CopySignal } from "@/lib/copy-trading";
import { checkWriteAllowed, isPaused } from "@/lib/ops/flags";
import { parseUsdcAtomic } from "@/lib/usdc";

export type CopyDryRunContext = Omit<CopyExecutionContext, "globalPaused" | "simulation">;

/**
 * A policy calculator for a supplied snapshot. No Soroban call, signature, audit
 * insert, reservation or transaction is made here. In particular, a positive
 * result is never an authorization to stake: the executor must re-read live
 * state and simulate the exact invocation before any funded action.
 */
export function buildCopyExecutionDryRun(args: {
  permission: CopyPermission;
  signal: CopySignal;
  context: CopyDryRunContext;
  env?: Record<string, string | undefined>;
}) {
  const env = args.env ?? process.env;
  const writeGate = checkWriteAllowed(
    { feature: "copy_trading", capability: "copy_execution", category: args.signal.category },
    env,
  );
  const previewGate = checkWriteAllowed(
    { capability: "copy_execution", category: args.signal.category }, env,
  );
  const decision = evaluateCopy(args.permission, args.signal, {
    ...args.context,
    globalPaused: isPaused("copy_execution", env),
    // This sentinel isolates policy checks. It is never presented as a
    // successful Soroban simulation or reused by a funded path.
    simulation: { ok: true, blockNumber: 0n },
  });
  let stakeAtomic: string | null = null;
  try { stakeAtomic = parseUsdcAtomic(args.signal.stakeUsdc).toString(); } catch { /* malformed input has no amount */ }

  return {
    mode: "dry_run" as const,
    stateSource: "supplied_snapshot" as const,
    policyEligible: previewGate.allowed && decision.allowed,
    reason: !decision.allowed ? decision.reason : !previewGate.allowed ? previewGate.reason : null,
    detail: !previewGate.allowed ? previewGate.detail : null,
    fundedGateOpen: writeGate.allowed,
    fundedGateBlock: writeGate.reason ?? null,
    stakeAtomic,
    simulation: "not_run" as const,
    executionReady: false as const,
    transactionSubmitted: false as const,
    feeQuote: null,
  };
}
