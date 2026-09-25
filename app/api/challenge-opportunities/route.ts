import { NextResponse } from "next/server";

import { apiError } from "@/lib/api/errors";
import { getChallengeOpportunities } from "@/lib/server/challenge-opportunities";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (process.env.NEXT_PUBLIC_FEATURE_SOURCE_DRAFTS !== "1") {
    const err = apiError("not_found", "Challenge opportunities are not enabled");
    return NextResponse.json(err.body, { status: err.status, headers: err.headers });
  }

  try {
    const { searchParams } = new URL(request.url);
    const locale = searchParams.get("locale") === "es" ? "es" : "en";
    const limitValue = searchParams.get("limit");
    const limit =
      limitValue && limitValue.trim().length > 0
        ? Number.parseInt(limitValue, 10)
        : undefined;

    if (limitValue && (!Number.isFinite(limit) || Number.isNaN(limit!))) {
      const err = apiError("invalid_request", "limit must be a valid integer", { field: "limit" });
      return NextResponse.json(err.body, { status: err.status, headers: err.headers });
    }

    const result = await getChallengeOpportunities({
      locale,
      limit,
    });

    return NextResponse.json(result, {
      headers: {
        "Cache-Control": "s-maxage=600, stale-while-revalidate=300",
      },
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Unable to load challenge opportunities";

    let code: "invalid_request" | "upstream_unavailable" | "internal_error" = "internal_error";
    if (/not configured|not enabled/i.test(message)) {
      code = "upstream_unavailable";
    } else if (/valid source URL|not supported|did not produce|readable text|Unable to fetch source|must be an HTML or text page/i.test(message)) {
      code = "invalid_request";
    }

    const err = apiError(code, message);
    return NextResponse.json(err.body, { status: err.status, headers: err.headers });
  }
}
