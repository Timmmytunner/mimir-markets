import { NextResponse } from "next/server";

import { generateClaimDrafts } from "@/lib/server/source-claim-generator";
import { apiError } from "@/lib/api/errors";

export const dynamic = "force-dynamic";

type ClaimDraftRequestBody = {
  url?: unknown;
  locale?: unknown;
};

export async function POST(request: Request) {
  if (process.env.NEXT_PUBLIC_FEATURE_SOURCE_DRAFTS !== "1") {
    const err = apiError("not_found", "Source drafting is not enabled");
    return NextResponse.json(err.body, { status: err.status, headers: err.headers });
  }

  try {
    const body = (await request.json()) as ClaimDraftRequestBody;
    const url = typeof body.url === "string" ? body.url.trim() : "";
    const locale = typeof body.locale === "string" ? body.locale.trim() : "en";

    if (!url) {
      const err = apiError("invalid_request", "url is required", { field: "url" });
      return NextResponse.json(err.body, { status: err.status, headers: err.headers });
    }

    const result = await generateClaimDrafts({ sourceUrl: url, locale });
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to draft claim suggestions";
    
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

