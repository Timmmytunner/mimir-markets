/**
 * Baskets a user composed.
 *
 * GET  lists them. POST creates one, owner-signed.
 *
 * The signature is the whole authorisation: a basket earns its creator a fee, so
 * "who made this" has to be something they proved rather than something they
 * typed. Same reasoning as agent registration.
 */

import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { isStellarAccount, verifyStellarSignedMessage } from "@/lib/stellar-message";

import { apiError } from "@/lib/api/errors";
import { authorizeRequest } from "@/lib/api/policy";
import { basketMessage, transferMessage, validateBasket, type BasketAgentWeight } from "@/lib/baskets";
import { DEFAULT_BASKET_POLICY } from "@/lib/server/basket-directory";
import { listDirectoryAgents } from "@/lib/server/agent-directory";
import { insertBasket, listBaskets } from "@/lib/db";

export const dynamic = "force-dynamic";

// Re-export so callers that import from this route path still resolve them —
// the canonical source is now lib/baskets.ts (importable in tests without the
// Next.js server stack), but nothing outside this file imported these before.
export { basketMessage, transferMessage };

function slugify(name: string): string {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}

function clientIp(req: NextRequest): string | undefined {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || undefined;
}

export async function GET(req: NextRequest) {
  const gate = authorizeRequest("public_read", { route: "/api/baskets", ip: clientIp(req) });
  if (!gate.allowed && gate.error) {
    return NextResponse.json(gate.error.body, { status: gate.error.status, headers: gate.error.headers });
  }
  const baskets = await listBaskets().catch(() => []);
  return NextResponse.json({ baskets }, { headers: { "cache-control": "no-store" } });
}

export async function POST(req: NextRequest) {
  const gate = authorizeRequest("public_read", { route: "/api/baskets", ip: clientIp(req) });
  if (!gate.allowed && gate.error) {
    return NextResponse.json(gate.error.body, { status: gate.error.status, headers: gate.error.headers });
  }

  let body: {
    name?: string; thesis?: string; creator?: string; signature?: string;
    members?: Array<{ agentId?: string; weightBps?: number }>;
  };
  try {
    body = await req.json();
  } catch {
    const err = apiError("invalid_request", "invalid JSON");
    return NextResponse.json(err.body, { status: err.status });
  }

  const name = String(body.name ?? "").trim().slice(0, 60);
  // Trimmed, never lowercased — see basketMessage above.
  const creator = String(body.creator ?? "").trim();
  const members = (body.members ?? [])
    .map((m) => ({ agentId: String(m.agentId ?? ""), weightBps: Math.round(Number(m.weightBps ?? 0)) }))
    .filter((m) => m.agentId && Number.isFinite(m.weightBps));

  if (!name || !isStellarAccount(creator) || members.length === 0) {
    const err = apiError("invalid_request", "name, creator and members are required");
    return NextResponse.json(err.body, { status: err.status });
  }

  // Members must exist. A basket naming an agent nobody can find would show a
  // weight that silently does nothing.
  const directory = await listDirectoryAgents().catch(() => []);
  const known = new Set(directory.map((agent) => agent.id));
  const missing = members.filter((m) => !known.has(m.agentId)).map((m) => m.agentId);
  if (missing.length > 0) {
    const err = apiError("invalid_request", `unknown agents: ${missing.join(", ")}`);
    return NextResponse.json(err.body, { status: err.status });
  }

  const weights: BasketAgentWeight[] = members.map((m) => {
    const agent = directory.find((candidate) => candidate.id === m.agentId)!;
    return { agentId: m.agentId, weightBps: m.weightBps, category: agent.track, mode: "pool" };
  });
  const policyErrors = validateBasket(weights, DEFAULT_BASKET_POLICY);
  if (policyErrors.length > 0) {
    const err = apiError("invalid_request", policyErrors.join(", "));
    return NextResponse.json(err.body, { status: err.status });
  }

  const signature = String(body.signature ?? "").trim();
  if (!signature) {
    const err = apiError("invalid_signature", "creator signature is required");
    return NextResponse.json(err.body, { status: err.status });
  }
  const valid = verifyStellarSignedMessage({
    address: creator,
    message: basketMessage({ name, creator, members }),
    signature,
  });
  if (!valid) {
    const err = apiError("invalid_signature", "creator signature rejected");
    return NextResponse.json(err.body, { status: err.status });
  }

  // Suffixed with a short random tail: two people naming a basket "Momentum" must
  // not collide, and a creator-prefixed id would leak the wallet into the URL.
  const basketId = `${slugify(name) || "basket"}-${randomUUID().slice(0, 6)}`;
  await insertBasket({
    basketId, creatorWallet: creator, name,
    thesis: String(body.thesis ?? "").trim().slice(0, 300),
    membersJson: JSON.stringify(members),
    createdAt: Date.now(),
  });

  return NextResponse.json({ basketId }, { headers: { "cache-control": "no-store" } });
}
