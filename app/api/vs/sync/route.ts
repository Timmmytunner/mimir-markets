import { NextResponse } from "next/server";

import {
  parseInviteKey,
  parsePositiveIntegerParam,
} from "@/lib/server/api-validation";
import { apiError } from "@/lib/api/errors";
import { triggerPostWriteRefresh } from "@/lib/server/vs-index";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

type RefreshBody = {
  claimId?: number;
  inviteKey?: string | null;
};

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as RefreshBody;
    const claimId = parsePositiveIntegerParam(
      payload.claimId == null ? undefined : String(payload.claimId)
    );

    if (!claimId) {
      const err = apiError("invalid_request", "Invalid claim id", { field: "claimId" });
      return NextResponse.json(err.body, { status: err.status, headers: err.headers });
    }

    const inviteKey = parseInviteKey(payload.inviteKey ?? null);
    if (inviteKey === null) {
      const err = apiError("invalid_request", "Invalid invite key", { field: "inviteKey" });
      return NextResponse.json(err.body, { status: err.status, headers: err.headers });
    }

    const claim = await triggerPostWriteRefresh({
      claimId,
      inviteKey,
    });

    return NextResponse.json(
      {
        indexed: Boolean(claim),
      },
      {
        status: claim ? 200 : 202,
        headers: {
          "Cache-Control": "no-store",
        },
      }
    );
  } catch {
    const err = apiError("internal_error", "Unable to refresh VS index");
    return NextResponse.json(err.body, { status: err.status, headers: err.headers });
  }
}
