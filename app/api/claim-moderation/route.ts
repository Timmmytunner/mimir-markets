import { NextResponse } from "next/server";

import {
  moderateClaim,
  type ClaimModerationInput,
} from "@/lib/server/claim-moderation";
import { handleClaimModerationPost } from "@/lib/server/claim-moderation-route-handler";
import {
  getGlobalCooldownMs,
  hashModerationInput,
  moderationInFlight,
  moderationResultCache,
  setGlobalCooldownMs,
} from "@/lib/server/moderation-cache";

export const dynamic = "force-dynamic";

type ModerationRequestBody = {
  locale?: unknown;
  input?: unknown;
};

function parseInput(value: unknown): ClaimModerationInput | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;

  const question = typeof row.question === "string" ? row.question : "";
  const creator_position =
    typeof row.creator_position === "string" ? row.creator_position : "";
  const opponent_position =
    typeof row.opponent_position === "string" ? row.opponent_position : "";
  const category = typeof row.category === "string" ? row.category : "";
  const settlement_rule =
    typeof row.settlement_rule === "string" ? row.settlement_rule : "";
  const resolution_url =
    typeof row.resolution_url === "string" ? row.resolution_url : "";

  if (
    !question.trim() ||
    !creator_position.trim() ||
    !opponent_position.trim() ||
    !category.trim() ||
    !settlement_rule.trim() ||
    !resolution_url.trim()
  ) {
    return null;
  }

  return {
    question,
    creator_position,
    opponent_position,
    category,
    settlement_rule,
    resolution_url,
  };
}

export async function POST(request: Request) {
  return handleClaimModerationPost({ request, moderateClaim });
}

