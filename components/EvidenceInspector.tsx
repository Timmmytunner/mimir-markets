"use client";

import { useState } from "react";
import { ChevronDown, ChevronUp, ShieldCheck } from "lucide-react";
import ResearchSourceCitations from "@/components/research/ResearchSourceCitations";
import type { VSData } from "@/lib/contract";
import {
  STELLAR_EXPLORER_URL,
  getExplorerAddressUrl,
  getMarketContractId,
} from "@/lib/stellar";

interface EvidenceInspectorProps {
  vs: VSData;
}

const WINNER_LABEL: Record<string, string> = {
  creator:      "Creator won",
  challengers:  "Challengers won",
  draw:         "Draw — both sides refunded",
  unresolvable: "Unresolvable — all refunded",
};

const CONFIDENCE_COLOR = (confidence: number) => {
  if (confidence >= 80) return "text-pv-emerald";
  if (confidence >= 60) return "text-amber-400";
  return "text-red-400";
};

export function EvidenceInspector({ vs }: EvidenceInspectorProps) {
  const [open, setOpen] = useState(false);

  const evidenceHash = (vs as any).evidence_hash as string | undefined;
  const hasEvidence  = evidenceHash && evidenceHash !== "0x" + "0".repeat(64);
  const confidence   = vs.confidence ?? 0;
  const winnerSide   = vs.winner_side ?? "";

  // Only show for resolved claims
  if (vs.state !== "resolved") return null;

  return (
    <div className="mt-4 rounded-2xl border border-pv-ink/[0.08] bg-pv-surface overflow-hidden">
      {/* Header — always visible */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between px-4 py-3 hover:bg-pv-ink/[0.02] transition-colors"
      >
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-pv-emerald" aria-hidden />
          <span className="text-[13px] font-semibold text-pv-text">Oracle Reasoning Trace</span>
          {hasEvidence && (
            <span className="rounded-full border border-pv-emerald/30 bg-pv-emerald/10 px-2 py-0.5 text-[10px] font-bold text-pv-emerald">
              ON-CHAIN
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className={`text-[12px] font-bold ${CONFIDENCE_COLOR(confidence)}`}>
            {confidence}% confidence
          </span>
          {open ? <ChevronUp className="h-4 w-4 text-pv-muted" /> : <ChevronDown className="h-4 w-4 text-pv-muted" />}
        </div>
      </button>

      {/* Expanded content */}
      {open && (
        <div className="border-t border-pv-ink/[0.06] px-4 pb-4 pt-3 space-y-4">
          {/* Verdict */}
          <div>
            <div className="mb-1 text-[10px] font-medium uppercase tracking-[0.16em] text-pv-muted">Verdict</div>
            <div className="text-[14px] font-semibold text-pv-text">
              {WINNER_LABEL[winnerSide] ?? winnerSide}
            </div>
          </div>

          {/* Confidence bar */}
          <div>
            <div className="mb-1 flex justify-between text-[10px] font-medium uppercase tracking-[0.16em] text-pv-muted">
              <span>Confidence</span>
              <span className={CONFIDENCE_COLOR(confidence)}>{confidence}%</span>
            </div>
            <div className="h-1.5 rounded-full bg-pv-ink/[0.06]">
              <div
                className={`h-1.5 rounded-full transition-all ${
                  confidence >= 80 ? "bg-pv-emerald" : confidence >= 60 ? "bg-amber-400" : "bg-red-400"
                }`}
                style={{ width: `${confidence}%` }}
              />
            </div>
          </div>

          {/* Explanation */}
          {vs.resolution_summary && (
            <div>
              <div className="mb-1 text-[10px] font-medium uppercase tracking-[0.16em] text-pv-muted">
                Oracle Explanation
              </div>
              <p className="text-[13px] text-pv-text/80 leading-relaxed">
                {vs.resolution_summary}
              </p>
            </div>
          )}

          {/* Research-source citations (primary locked URL + hash) */}
          <ResearchSourceCitations
            sources={[
              {
                url: vs.resolution_url,
                trustTier: "primary",
                contentHash: evidenceHash,
                excerpt: vs.resolution_summary,
              },
            ]}
            deadlineUnix={typeof vs.deadline === "number" ? vs.deadline : null}
            cancelled={false}
          />

          {/* Evidence hash */}
          {hasEvidence && (
            <div>
              <div className="mb-1 text-[10px] font-medium uppercase tracking-[0.16em] text-pv-muted">
                Evidence Hash (on-chain)
              </div>
              <div className="rounded-lg border border-pv-emerald/[0.15] bg-pv-emerald/[0.04] px-3 py-2">
                <code className="break-all font-mono text-[11px] text-pv-emerald">
                  {evidenceHash}
                </code>
              </div>
              <p className="mt-1 text-[11px] text-pv-muted">
                The oracle fetched the evidence URL, hashed it with SHA-256, and stored this hash on Stellar.
                You can verify the evidence by fetching the URL and computing the SHA-256 of the text content.
              </p>
            </div>
          )}

          {/* How to verify */}
          <div className="rounded-xl border border-pv-ink/[0.06] bg-pv-ink/[0.02] px-3 py-2">
            <div className="text-[10px] font-medium uppercase tracking-[0.16em] text-pv-muted mb-1">
              How to verify
            </div>
            <ol className="text-[11px] text-pv-muted space-y-0.5 list-decimal list-inside">
              <li>Fetch the evidence URL above</li>
              <li>Strip HTML and compute keccak256 of the text</li>
              <li>Compare to the on-chain hash</li>
              <li>
                <a
                  href={getExplorerAddressUrl(getMarketContractId())}
                  target="_blank"
                  rel="noreferrer"
                  className="text-pv-cyan hover:text-pv-text"
                >
                  View Mimir contract on stellar.expert ↗
                </a>
                {" "}
                <span className="text-pv-muted/70">({STELLAR_EXPLORER_URL})</span>
              </li>
            </ol>
          </div>
        </div>
      )}
    </div>
  );
}
