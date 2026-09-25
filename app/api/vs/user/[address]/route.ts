import { NextRequest, NextResponse } from "next/server";

import {
  parseAddressParam,
} from "@/lib/server/api-validation";
import { apiError } from "@/lib/api/errors";
import { getUserVsSnapshot } from "@/lib/server/vs-index";
import { VS_CACHE_HEADERS } from "@/lib/server/vs-cache";

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ address: string }> }
) {
  try {
    const { address: rawAddress } = await params;
    const address = parseAddressParam(rawAddress);
    if (!address) {
      const err = apiError("invalid_request", "Invalid address", { field: "address" });
      return NextResponse.json(err.body, { status: err.status, headers: err.headers });
    }

    const refreshValue = new URL(request.url).searchParams.get("refresh");
    if (refreshValue && refreshValue !== "1") {
      const err = apiError("invalid_request", "refresh must be 1 when provided", { field: "refresh" });
      return NextResponse.json(err.body, { status: err.status, headers: err.headers });
    }

    const { items, cache } = await getUserVsSnapshot(address, {
      forceRefresh: refreshValue === "1",
    });

    return NextResponse.json(
      {
        items,
        count: items.length,
        cache,
      },
      {
        headers: VS_CACHE_HEADERS,
      }
    );
  } catch {
    const err = apiError("internal_error", "Unable to load user VS");
    return NextResponse.json(err.body, { status: err.status, headers: err.headers });
  }
}
