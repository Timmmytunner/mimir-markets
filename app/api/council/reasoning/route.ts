/**
 * Council reasoning, pay-per-read — creator monetization.
 *
 * GET /api/council/reasoning?claimId=12&persona=optimist   ($0.001 USDC / read)
 *
 * Each of the 10 council personas is a "creator": a reader signs a small USDC
 * authorization to unlock that persona's take on a claim, and the USDC lands
 * DIRECTLY in that persona's own wallet (payTo = persona address).
 * Unpaid → PAYMENT-REQUIRED 402.
 */

import { NextResponse, type NextRequest } from "next/server";
import { paidRoute, queryParam } from "@/lib/x402/server";
import type { HTTPRequestContext } from "@x402/core/http";
import { PRICES } from "@/lib/x402/config";
import { verifyPass } from "@/lib/paid-pass";
import { getPersonaBySlug } from "@/agents/council/personas";
import { getCouncilAddress } from "@/lib/agent-wallets";
import { readClaimRaw } from "@/lib/contract";
import { callLLM } from "@/lib/llm";
import { getCachedReasoning, setCachedReasoning, TTL_MS } from "@/lib/server/reasoning-cache";
import { buildVSCacheFreshness } from "@/lib/vs-freshness";

const PASS_PLAN = "council";

/** Recipient of this read's payment — the persona itself, not the platform. */
function personaAddress(ctx: HTTPRequestContext): string {
  const slug = queryParam(ctx, "persona").toLowerCase().trim();
  const payTo = getCouncilAddress(slug);
  if (!payTo) throw new Error(`persona '${slug}' has no wallet configured`);
  return payTo;
}

/** A valid council pass unlocks reads for its window — no per-read payment. */
function hasCouncilPass(req: NextRequest): boolean {
  return !!verifyPass(req.nextUrl.searchParams.get("pass"), PASS_PLAN);
}

async function handler(req: NextRequest): Promise<NextResponse> {
  const { searchParams } = req.nextUrl;
  const claimId = Number(searchParams.get("claimId"));
  const slug = (searchParams.get("persona") ?? "").toLowerCase().trim();
  const hasPass = hasCouncilPass(req);

  const persona = getPersonaBySlug(slug);
  if (!persona) {
    return NextResponse.json({ error: `unknown persona '${slug}'` }, { status: 400 });
  }
  if (!Number.isInteger(claimId) || claimId < 1) {
    return NextResponse.json({ error: "claimId must be a positive integer" }, { status: 400 });
  }
  const payTo = getCouncilAddress(slug);
  if (!payTo) {
    return NextResponse.json({ error: `persona '${slug}' has no wallet configured` }, { status: 503 });
  }

  // A warm (claim, persona) pair skips both the contract read and the LLM call;
  // the read stays billed either way.
  const cached = getCachedReasoning(claimId, slug);
  if (cached) {
    return NextResponse.json({
      persona: { slug: persona.slug, name: persona.displayName, emoji: persona.emoji },
      claimId,
      question: cached.question,
      reasoning: cached.reasoning,
      paidTo: hasPass ? null : payTo,
      price: hasPass ? "$0 (pass)" : PRICES.councilReasoning,
      freshness: buildVSCacheFreshness({
        updatedAtMs: cached.at,
        freshnessWindowMs: TTL_MS,
        source: "index",
      }),
    });
  }

  // Read the claim, then produce this persona's reasoning.
  let question = "";
  let sideA = "";
  let sideB = "";
  try {
    // Named fields from the generated bindings. The EVM version read a positional
    // tuple and used a zero-address creator as the "not found" sentinel; Soroban
    // answers `Err(ClaimNotFound)`, which `readClaimRaw` surfaces as null — so the
    // absent case is explicit rather than inferred from a magic address.
    const claim = await readClaimRaw(claimId);
    if (!claim) {
      return NextResponse.json({ error: `claim ${claimId} not found` }, { status: 404 });
    }
    question = claim.question;
    sideA = claim.creator_position;
    sideB = claim.counter_position;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "read failed";
    return NextResponse.json({ error: msg }, { status: 502 });
  }

  const prompt = `${persona.promptBias}

You are giving your personal take, in character, on a prediction market claim.

**Claim:** ${question}
**Side A (creator):** ${sideA}
**Side B (challenger):** ${sideB}

Write one tight paragraph (max 90 words): which side you lean toward and your honest reasoning. Stay in character.`;

  let reasoning = "";
  let generatedAtMs = Date.now();
  try {
    reasoning = (await callLLM(prompt, { maxTokens: 300 })).trim();
    if (reasoning) {
      // Only successful generations are cached — never the fallback below.
      setCachedReasoning(claimId, slug, { question, sideA, sideB, reasoning }, generatedAtMs);
    }
  } catch {
    reasoning = "(reasoning unavailable right now)";
  }

  return NextResponse.json({
    persona: { slug: persona.slug, name: persona.displayName, emoji: persona.emoji },
    claimId,
    question,
    reasoning,
    paidTo: hasPass ? null : payTo,
    price: hasPass ? "$0 (pass)" : PRICES.councilReasoning,
    freshness: reasoning === "(reasoning unavailable right now)" ? null : buildVSCacheFreshness({
      updatedAtMs: generatedAtMs,
      freshnessWindowMs: TTL_MS,
      source: "contract",
    }),
  });
}

// Dynamic payTo: each persona is paid into its own wallet. A council pass
// bypasses the paywall entirely.
export const GET = paidRoute("councilReasoning", handler, {
  payTo: personaAddress,
  skipPayment: hasCouncilPass,
});
