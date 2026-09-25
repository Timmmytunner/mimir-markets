/**
 * GET /api/vs/[id]/council
 *
 * Returns the council's record on a single claim:
 *   - which personas have staked on the challenger side
 *   - how much each persona staked
 *   - the tx hash that proves it, when it is still in the RPC's event window
 *
 * ── One read instead of a log scan ──────────────────────────────────────────
 *
 * The EVM version derived this by scanning `ClaimChallenged` logs from the deploy
 * block and cross-referencing the persona addresses. On Soroban the challenger
 * ROSTER is part of the claim: `get_claim` returns every challenger with their
 * stake, so the authoritative answer is one read with no paging, no block range,
 * and no chance of a filter mistake smearing one claim's stakes onto another.
 *
 * The tx hash is the one thing the roster does not carry, so it is filled in
 * best-effort from `claim_challenged` events — and only best-effort ON PURPOSE:
 * Soroban RPC retains a rolling ~7-day event window, so a stake older than that
 * has no recoverable hash. Reporting `staked: true` with `txHash: null` is correct
 * and honest; deriving the roster from those same events would instead have made
 * an old stake disappear from the council's record entirely.
 */

import { NextResponse } from "next/server";

import { readClaimRaw } from "@/lib/contract";
import { getContractEvents, isMarketConfigured, requireMarketContractId } from "@/lib/stellar";
import {
  listCouncilPersonas,
  personaPublicEnv,
  type PersonaSpec,
} from "@/agents/council/personas";
import { scValToNative } from "@stellar/stellar-sdk";
import { makeContractFreshness, type VSCacheFreshness } from "@/lib/vs-freshness";

export const revalidate = 20;

interface PersonaVote {
  slug:        string;
  displayName: string;
  emoji:       string;
  archetype:   PersonaSpec["archetype"];
  accent:      PersonaSpec["accent"];
  staked:      boolean;
  stakeUsdc:   number;
  txHash:      string | null;
  /** Ledger the stake landed in. Null when it aged out of the event window. */
  ledger:      number | null;
}

interface CouncilResponse {
  claimId:    number;
  total:      number;
  stakedCount: number;
  totalUsdc:  number;
  votes:      PersonaVote[];
  cache:      VSCacheFreshness;
}

/**
 * Tx hash + ledger per challenger, from `claim_challenged` events.
 *
 * Verified against the deployed contract: a `#[contractevent]` publishes
 * `topic[0]` = the event name, `topic[1..]` = the `#[topic]` fields in declaration
 * order — here `id` then `challenger` — so the challenger address is `topic[2]`.
 * Never throws: a proof link is a nicety and the roster is the record.
 */
async function eventProofs(claimId: number): Promise<Map<string, { txHash: string; ledger: number }>> {
  const proofs = new Map<string, { txHash: string; ledger: number }>();
  try {
    const scan = await getContractEvents(requireMarketContractId(), { maxPages: 20 });
    for (const event of scan.events) {
      const topics = event.topic ?? [];
      if (topics.length < 3) continue;
      try {
        if (String(scValToNative(topics[0])) !== "claim_challenged") continue;
        if (Number(scValToNative(topics[1])) !== claimId) continue;
        const challenger = String(scValToNative(topics[2]));
        // Last write wins: a later ledger is the more recent proof for the same
        // account, and the roster holds only one entry per challenger anyway.
        proofs.set(challenger, {
          txHash: event.txHash ?? "",
          ledger: Number(event.ledger ?? 0),
        });
      } catch {
        continue;
      }
    }
  } catch (err) {
    console.warn("[api/vs/council] event scan unavailable:", err instanceof Error ? err.message : err);
  }
  return proofs;
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: rawId } = await ctx.params;
  const claimId = Number(rawId);
  if (!Number.isFinite(claimId) || claimId <= 0) {
    return NextResponse.json({ error: "invalid claim id" }, { status: 400 });
  }

  const personas = listCouncilPersonas();
  const empty: CouncilResponse = {
    claimId,
    total: personas.length,
    stakedCount: 0,
    totalUsdc: 0,
    votes: [],
    cache: makeContractFreshness(),
  };

  if (!isMarketConfigured()) {
    return NextResponse.json({ ...empty, total: 0 } satisfies CouncilResponse);
  }

  const claim = await readClaimRaw(claimId);
  if (!claim) {
    return NextResponse.json({ error: `claim ${claimId} not found` }, { status: 404 });
  }

  // Roster keyed by address. Stakes are already display USDC — `decodeClaim`
  // converted them, so there is no atomic arithmetic left here.
  const stakeByAddress = new Map<string, number>();
  for (const entry of claim.challengers ?? []) {
    stakeByAddress.set(entry.address, entry.stake);
  }

  const proofs = stakeByAddress.size > 0 ? await eventProofs(claimId) : new Map();

  const votes: PersonaVote[] = personas.map((p) => {
    // EXACT match on the configured public key: a Stellar strkey is case-sensitive
    // base32, so the EVM `toLowerCase()` on both sides would match nothing and
    // every persona would read as "did not stake".
    const addr = process.env[personaPublicEnv(p)]?.split(/\s+#/)[0].trim();
    const stake = addr ? stakeByAddress.get(addr) : undefined;
    const proof = addr ? proofs.get(addr) : undefined;
    return {
      slug:        p.slug,
      displayName: p.displayName,
      emoji:       p.emoji,
      archetype:   p.archetype,
      accent:      p.accent,
      staked:      stake !== undefined,
      stakeUsdc:   stake ?? 0,
      txHash:      proof?.txHash ?? null,
      ledger:      proof?.ledger ?? null,
    };
  });

  const stakedCount = votes.filter((v) => v.staked).length;
  const totalUsdc   = votes.reduce((acc, v) => acc + v.stakeUsdc, 0);

  const body: CouncilResponse = {
    claimId,
    total:       votes.length,
    stakedCount,
    totalUsdc,
    votes,
    cache: makeContractFreshness(),
  };
  return NextResponse.json(body, {
    headers: { "cache-control": "public, s-maxage=20, stale-while-revalidate=60" },
  });
}
