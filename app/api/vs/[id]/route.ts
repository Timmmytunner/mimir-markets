import { NextRequest, NextResponse } from "next/server";

import {
  parseInviteKey,
  parsePositiveIntegerParam,
} from "@/lib/server/api-validation";
import { apiError } from "@/lib/api/errors";
import { getVsDetailSnapshot, getVsWithInvite } from "@/lib/server/vs-index";
import { makeContractFreshness } from "@/lib/vs-freshness";
import { VS_CACHE_HEADERS } from "@/lib/server/vs-cache";

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const vsId = parsePositiveIntegerParam(id);
    if (!vsId) {
      const err = apiError("invalid_request", "Invalid VS id", { field: "id" });
      return NextResponse.json(err.body, { status: err.status, headers: err.headers });
    }

    const inviteKey = parseInviteKey(
      new URL(request.url).searchParams.get("invite")
    );
    if (inviteKey === null) {
      const err = apiError("invalid_request", "Invalid invite key", { field: "invite" });
      return NextResponse.json(err.body, { status: err.status, headers: err.headers });
    }

    if (inviteKey) {
      const privateItem = await getVsWithInvite(vsId, inviteKey);
      if (!privateItem) {
        const err = apiError("not_found", "VS not found");
        return NextResponse.json(err.body, { status: err.status, headers: err.headers });
      }

      return NextResponse.json(
        {
          item: privateItem,
          cache: makeContractFreshness(),
        },
        {
          headers: {
            "Cache-Control": "private, no-store",
          },
        }
      );
    }

    const { item, cache } = await getVsDetailSnapshot(vsId);
    if (!item) {
      const err = apiError("not_found", "VS not found");
      return NextResponse.json(err.body, { status: err.status, headers: err.headers });
    }

    return NextResponse.json(
      {
        item,
        cache,
      },
      {
        headers: VS_CACHE_HEADERS,
      }
    );
  } catch {
    const err = apiError("internal_error", "Unable to load VS");
    return NextResponse.json(err.body, { status: err.status, headers: err.headers });
  }
}
