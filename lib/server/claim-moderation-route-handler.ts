import { NextResponse } from "next/server";

import { apiError } from "@/lib/api/errors";
import {
  getGlobalCooldownMs,
  hashModerationInput,
  moderationInFlight,
  moderationResultCache,
  setGlobalCooldownMs,
} from "@/lib/server/moderation-cache";

export type ClaimModerationInput = {
  question: string;
  creator_position: string;
  opponent_position: string;
  category: string;
  settlement_rule: string;
  resolution_url: string;
};

export type ClaimModerationResult = {
  decision: "allow" | "review" | "block";
  violationCodes: string[];
  confidence: number;
  policyVersion: string;
};

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

export async function handleClaimModerationPost(args: {
  request: Request;
  moderateClaim: (input: { input: ClaimModerationInput; locale: string }) => Promise<ClaimModerationResult>;
}) {
  if (process.env.NEXT_PUBLIC_FEATURE_CLAIM_MODERATION !== "1") {
    const err = apiError("not_found", "Claim moderation is not enabled");
    return NextResponse.json(err.body, { status: err.status, headers: err.headers });
  }

  try {
    const body = (await args.request.json()) as ModerationRequestBody;
    const locale = typeof body.locale === "string" ? body.locale.trim() : "en";
    const input = parseInput(body.input);

    if (!input) {
      const err = apiError("invalid_request", "input is required", { field: "input" });
      return NextResponse.json(err.body, { status: err.status, headers: err.headers });
    }

    const cooldownMs = getGlobalCooldownMs();
    if (cooldownMs > 0) {
      const seconds = Math.max(1, Math.ceil(cooldownMs / 1000));
      const err = apiError("rate_limited", `Moderation is rate-limited. Retry in ${seconds}s.`, { retryAfterSeconds: seconds });
      return NextResponse.json(err.body, { status: err.status, headers: err.headers });
    }

    const key = hashModerationInput({ locale, input });
    const cached = moderationResultCache.get(key);
    if (cached) {
      return NextResponse.json(cached, {
        headers: {
          "X-Moderation-Cache": "HIT",
        },
      });
    }

    const existing = moderationInFlight.get(key);
    if (existing) {
      const result = await existing;
      return NextResponse.json(result, {
        headers: {
          "X-Moderation-Dedupe": "INFLIGHT",
        },
      });
    }

    const p = args
      .moderateClaim({ input, locale })
      .then((result) => {
        const ttlMs =
          result.decision === "allow" ? 24 * 60 * 60 * 1000 : 10 * 60 * 1000;
        moderationResultCache.set(key, result, ttlMs);
        return result;
      })
      .finally(() => {
        moderationInFlight.delete(key);
      });

    moderationInFlight.set(key, p);
    const result = await p;
    return NextResponse.json(result, {
      headers: {
        "X-Moderation-Cache": "MISS",
      },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unable to moderate claim";
    const isRateLimited =
      /request failed\s*\(429\)|RESOURCE_EXHAUSTED|quota|rate limit/i.test(
        message
      );
    if (isRateLimited) {
      setGlobalCooldownMs(35_000);
    }
    
    let code: "upstream_unavailable" | "rate_limited" | "internal_error" = "internal_error";
    let retryAfterSeconds: number | undefined;

    if (/not configured|not enabled/i.test(message)) {
      code = "upstream_unavailable";
    } else if (isRateLimited) {
      code = "rate_limited";
      retryAfterSeconds = 35;
    }

    const err = apiError(code, message, { retryAfterSeconds });
    return NextResponse.json(err.body, { status: err.status, headers: err.headers });
  }
}

