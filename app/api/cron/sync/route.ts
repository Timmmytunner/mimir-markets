import { authorizeRequest } from "@/lib/api/policy";
import { NextResponse } from "next/server";

import { beat } from "@/lib/ops/heartbeat";
import { apiError } from "@/lib/api/errors";
import { reconcileVsIndex } from "@/lib/server/vs-index";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Manual/external trigger for the same reconcile the `sync` worker runs on its own
 * interval (agents/sync/index.ts), so it reports the same heartbeat — an operator
 * kicking the index by hand is a real sync, and the probe should see it.
 *
 * Keep in step with SYNC_POLL_INTERVAL_MS: the probe derives its staleness
 * thresholds from the declared interval, and a value shorter than the real cadence
 * would alarm on a healthy worker.
 */
const SYNC_INTERVAL_SEC = Number(process.env.SYNC_POLL_INTERVAL_MS ?? "300000") / 1000;

/**
 * Worker-tier authorization, delegated to lib/api/policy.ts.
 *
 * Was a local Bearer-token string comparison duplicated in two routes. Two
 * copies of an auth check is two places for one of them to drift, and a plain
 * string compare on a secret leaks its length through timing. The tier also
 * applies the route rate limit, which this route previously had none of.
 */
function authorizeWorker(request: Request, route: string) {
  const header = request.headers.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  return authorizeRequest("internal_worker", {
    route,
    presentedSecret: presented,
    expectedSecret: process.env.CRON_SECRET,
  });
}

export async function GET(request: Request) {
  // Authorized outside the try: an unauthenticated caller must never reach the
  // heartbeat below, not even through the error path, or it could keep a dead
  // sync worker looking merely degraded instead of missing.
  const auth = authorizeWorker(request, "/api/cron/sync");
  if (!auth.allowed && auth.error) {
    // The tier's error already carries a machine-readable code, a retryable flag
    // and a Retry-After when waiting can help.
    return NextResponse.json(auth.error.body, {
      status: auth.error.status,
      headers: auth.error.headers,
    });
  }

  try {
    const summary = await reconcileVsIndex();
    await beat("sync", { intervalSec: SYNC_INTERVAL_SEC });

    return NextResponse.json(
      {
        synced: summary.synced,
        new: summary.new,
        stateChanges: summary.stateChanges,
      },
      {
        headers: {
          "Cache-Control": "no-store",
        },
      }
    );
  } catch (error) {
    // Alive and failing, which staleness alone would report as healthy.
    await beat("sync", { error, intervalSec: SYNC_INTERVAL_SEC });
    const err = apiError("internal_error", "Unable to reconcile VS index");
    return NextResponse.json(err.body, { status: err.status, headers: err.headers });
  }
}
