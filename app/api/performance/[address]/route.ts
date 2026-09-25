import { NextResponse } from "next/server";

import {
  computeAgentPerformance,
  cumulativePnlPoints,
} from "@/lib/agents/performance";
import { getAgentTradeRows, getSyncMeta } from "@/lib/db";
import type { PortfolioPerformanceResponse } from "@/lib/portfolio-performance";
import {
  parseAddressParam,
} from "@/lib/server/api-validation";
import { apiError } from "@/lib/api/errors";
import { buildVSCacheFreshness } from "@/lib/vs-freshness";

export const dynamic = "force-dynamic";

const DEFAULT_SYNC_INTERVAL_MS = 300_000;
const SETTLEMENT_LAST_SYNC_META_KEY = "settlement_last_sync_at";

function performanceFreshnessWindowMs(): number {
  const configured = Number(process.env.SYNC_POLL_INTERVAL_MS ?? DEFAULT_SYNC_INTERVAL_MS);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_SYNC_INTERVAL_MS;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ address: string }> },
) {
  const { address: rawAddress } = await params;
  const address = parseAddressParam(rawAddress);
  if (!address) {
    const err = apiError("invalid_request", "Invalid address", { field: "address" });
    return NextResponse.json(err.body, { status: err.status, headers: { ...err.headers, "Cache-Control": "no-store" } });
  }

  try {
    const [rows, lastSettlementSync] = await Promise.all([
      getAgentTradeRows(address),
      getSyncMeta(SETTLEMENT_LAST_SYNC_META_KEY),
    ]);
    const { performance, results } = computeAgentPerformance(rows);
    const updatedAtMs = Number(lastSettlementSync ?? "0");

    const body: PortfolioPerformanceResponse = {
      points: cumulativePnlPoints(results),
      settled: performance.settled,
      cache: buildVSCacheFreshness({
        updatedAtMs:
          Number.isFinite(updatedAtMs) && updatedAtMs > 0 ? updatedAtMs : null,
        freshnessWindowMs: performanceFreshnessWindowMs(),
        source: "index",
      }),
    };

    return NextResponse.json(body, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    const err = apiError("upstream_unavailable", "Unable to load portfolio performance");
    return NextResponse.json(err.body, { status: err.status, headers: { ...err.headers, "Cache-Control": "no-store" } });
  }
}

