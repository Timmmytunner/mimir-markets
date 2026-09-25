import { authorizeRequest } from "@/lib/api/policy";
import { NextResponse } from "next/server";

import { apiError } from "@/lib/api/errors";
import { refreshChallengeOpportunitiesIndex } from "@/lib/server/challenge-opportunities";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

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
  try {
    const auth = authorizeWorker(request, "/api/cron/challenge-opportunities");
    if (!auth.allowed && auth.error) {
      // The tier's error already carries a machine-readable code, a retryable flag
      // and a Retry-After when waiting can help.
      return NextResponse.json(auth.error.body, {
        status: auth.error.status,
        headers: auth.error.headers,
      });
    }

    if (process.env.NEXT_PUBLIC_FEATURE_SOURCE_DRAFTS !== "1") {
      const err = apiError("not_found", "Challenge opportunities are not enabled");
      return NextResponse.json(err.body, { status: err.status, headers: err.headers });
    }

    const summary = await refreshChallengeOpportunitiesIndex();

    return NextResponse.json(
      {
        generatedAt: new Date(summary.generatedAt).toISOString(),
        locales: summary.locales,
        countsByLocale: summary.countsByLocale,
      },
      {
        headers: {
          "Cache-Control": "no-store",
        },
      }
    );
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Unable to refresh challenge opportunities";

    const code = /not configured/i.test(message) ? "upstream_unavailable" : "internal_error";
    const err = apiError(code, message);

    return NextResponse.json(err.body, { status: err.status, headers: err.headers });
  }
}
