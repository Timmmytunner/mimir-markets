/**
 * Cron: prune expired agent API nonces.
 *
 * Rows in `agent_api_nonces` with `expires_at <= now` are outside the envelope
 * skew window (±5 min) and can never be presented as a valid replay again. This
 * route deletes them so the table stays bounded.
 *
 * Recommended schedule: every 15–30 minutes. A nonce TTL is 10 minutes, so
 * running this every 15 minutes means the table holds at most ~1.5× the number
 * of requests seen in one TTL window at peak load — far below any meaningful
 * storage concern.
 *
 * Authorization: same `CRON_SECRET` bearer pattern as the other cron routes.
 */

import { NextResponse } from "next/server";
import { authorizeRequest } from "@/lib/api/policy";
import { pruneExpiredNonces } from "@/lib/server/nonce-store";

export const dynamic = "force-dynamic";

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
  const auth = authorizeWorker(request, "/api/cron/nonce-prune");
  if (!auth.allowed && auth.error) {
    return NextResponse.json(auth.error.body, {
      status: auth.error.status,
      headers: auth.error.headers,
    });
  }

  try {
    const pruned = await pruneExpiredNonces();
    return NextResponse.json(
      { pruned, at: Date.now() },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      { error: "prune failed", detail: error instanceof Error ? error.message : String(error) },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
