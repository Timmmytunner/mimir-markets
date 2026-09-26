/**
 * Mimir Council Worker
 *
 * Boots a single Node process that runs 10 AI personas as autonomous
 * economic actors on Stellar. Every cycle:
 *
 *   1. Reads the claim count + each open/active claim from the contract.
 *   2. Builds a per-cycle evidence cache so 10 personas share 1 HTTP
 *      fetch per resolution URL.
 *   3. For each (claim, persona) pair, runs the decision pipeline:
 *        - Specialists skip out-of-category claims (no LLM call)
 *        - Rule-based personas evaluate from pool state (no LLM call)
 *        - LLM personas call Gemini with a persona-specific prompt prefix
 *   4. Submits challenge_claim through the persona's own Stellar keypair when the
 *      decision says stake.
 *
 * The persona reasoning, rate-limit strategy and cycle budgeting are unchanged.
 * What changed is the read: one `get_claim` returns the whole struct INCLUDING the
 * challenger roster, so the per-claim reads dropped from three to one and the
 * rule-based evaluators no longer touch the chain at all.
 *
 * Rate-limit strategy:
 *   - Personas are processed sequentially within a cycle (not in parallel).
 *   - Gemini free tier = 15 req/min. With 10 LLM personas across ~60s of
 *     work per cycle, we stay comfortably under.
 *   - Rule-based + category-filtered personas don't consume LLM budget.
 *
 * Run: npm run council  (or via "npm run workers" alongside oracle + market-creator)
 * Env: COUNCIL_<SLUG>_PRIVATE_KEY for each persona (addresses derived),
 *      NEXT_PUBLIC_CONTRACT_ADDRESS,
 *      GEMINI_API_KEY (preferred) OR ANTHROPIC_API_KEY
 *      COUNCIL_PERSONAS_ACTIVE (optional CSV of slugs, e.g.
 *        "optimist,pessimist,statistician,whale_watcher,doomer" — restricts
 *        active personas to this subset, cuts LLM load proportionally).
 */

// Worker-scoped Gemini key. Falls back to the shared GEMINI_API_KEY when
// COUNCIL_GEMINI_API_KEY is not set. See agents/oracle/index.ts for the
// rationale: each worker gets its own 20 RPM free-tier bucket.
applyWorkerGeminiKey("COUNCIL_GEMINI_API_KEY");

import { requireAnyLLMKey, applyWorkerGeminiKey } from "../../lib/agent-bootstrap";
import { getClaimCount, readClaimRaw } from "../../lib/contract";
import { readAgentBalances } from "../../lib/agent-wallets";
import { STELLAR_NETWORK, requireMarketContractId } from "../../lib/stellar";
import { unitsToUsdc } from "../../lib/usdc";
import { reportingPoll } from "../../lib/ops/heartbeat";
import { activeLLMProvider, activeLLMModel, activeLLMKeyFingerprint } from "../../lib/llm";
import {
  listCouncilPersonas,
  personaPublicEnv,
  personaSecretEnv,
  type PersonaSpec,
} from "./personas";
import {
  PHILOSOPHER_PERSONAS,
  activePhilosophers,
  isPhilosopher,
  philosopherPublicEnv,
  philosopherSecretEnv,
} from "./philosophers";
import { runPersonaForClaim } from "./shared/persona-runner";
import { buyPeerReasoning } from "./shared/peer-reasoning";
import { toClaimOnChain } from "./shared/types";
import type {
  ClaimOnChain,
  PersonaRunnerContext,
  EvidenceCacheEntry,
} from "./shared/types";

const POLL_INTERVAL_MS = Number(process.env.COUNCIL_POLL_INTERVAL_MS ?? 180_000);
/**
 * Per-cycle work cap to stay under Gemini free-tier rate limits.
 * Claims are sorted by deadline-proximity so the council focuses on
 * the markets closest to settling.
 */
const MAX_CLAIMS_PER_CYCLE = Number(process.env.COUNCIL_MAX_CLAIMS ?? 1);
const DECISION_DELAY_MS    = Number(process.env.COUNCIL_DECISION_DELAY_MS ?? 30000);
const PEER_READS_ENABLED   = process.env.COUNCIL_PEER_READS === "1";
const PEER_READS_BASE_URL  = process.env.MIMIR_BASE_URL ?? "http://localhost:3000";
const PEER_READS_PER_PERSONA = Number(process.env.COUNCIL_PEER_READS_PER_PERSONA ?? 2);
const PEER_READ_DELAY_MS   = Number(process.env.COUNCIL_PEER_READ_DELAY_MS ?? 15000);
const PEER_READ_CAP_USDC   = Number(process.env.COUNCIL_PEER_READ_CAP_USDC ?? "0.003");
const CONTRACT_ID          = requireMarketContractId();

// ── Env guard ─────────────────────────────────────────────────────────────────
requireAnyLLMKey();

// Optional CSV allowlist of persona slugs to keep active. When set, personas
// not in the list are skipped even if their wallets exist — used to scale LLM
// load down without re-provisioning wallets.
const PERSONA_ALLOWLIST = (() => {
  const raw = process.env.COUNCIL_PERSONAS_ACTIVE?.trim();
  if (!raw) return null;
  const slugs = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return slugs.length > 0 ? new Set(slugs) : null;
})();

// Skip personas missing a private key (e.g. before agents:create-wallets has
// run for that persona). Warn once at startup, not every cycle.
const CLASSIC_PERSONAS = listCouncilPersonas();
const ACTIVE_PERSONAS = CLASSIC_PERSONAS.filter((p) => {
  if (PERSONA_ALLOWLIST && !PERSONA_ALLOWLIST.has(p.slug)) {
    return false;
  }
  const ok = !!process.env[personaSecretEnv(p)];
  if (!ok) {
    console.warn(
      `[council] ${p.emoji} ${p.displayName} is missing ${personaSecretEnv(p)} — skipping. ` +
      `Run "npm run agents:create-wallets" to provision.`,
    );
  }
  return ok;
});

/**
 * The philosopher track (§04) runs alongside the classic personas.
 *
 * Kept as a separate list rather than merged into COUNCIL_PERSONAS so the two
 * juries can be filtered, funded and scaled independently — and so a combined
 * consensus can be computed without first having to work out which persona
 * belonged to which track. `COUNCIL_PHILOSOPHERS=0` runs the classic jury alone.
 *
 * Each philosopher carries its own wallet env and its own risk limits; a
 * philosopher with no key is skipped exactly like a classic persona, so the track
 * degrades to whatever has been provisioned instead of failing the worker.
 */
const PHILOSOPHERS_ENABLED = process.env.COUNCIL_PHILOSOPHERS !== "0";
const ACTIVE_PHILOSOPHERS: PersonaSpec[] = PHILOSOPHERS_ENABLED
  ? activePhilosophers().filter((p) => {
      const ok = !!process.env[philosopherSecretEnv(p.slug)];
      if (!ok) {
        console.warn(
          `[council] ${p.emoji} ${p.displayName} is missing ${philosopherSecretEnv(p.slug)} — skipping. ` +
          `Run "npm run agents:create-wallets" to provision.`,
        );
      }
      return ok;
    })
  : [];

/** Both juries, in one list for the cycle loop. Track stays readable per persona. */
const ALL_ACTIVE = [...ACTIVE_PERSONAS, ...ACTIVE_PHILOSOPHERS];

if (ALL_ACTIVE.length === 0) {
  console.error("[council] No personas have wallets configured. Exiting.");
  process.exit(1);
}

// ── Fetch claim ───────────────────────────────────────────────────────────────
/**
 * One `get_claim` + roster read, mapped onto the runner's camelCase shape.
 *
 * `readClaimRaw` already retries and answers null for a missing claim (Soroban
 * returns `Err(ClaimNotFound)` rather than throwing), so there is no try/catch
 * left to add here.
 */
async function fetchClaim(claimId: number): Promise<ClaimOnChain | null> {
  const claim = await readClaimRaw(claimId);
  return claim ? toClaimOnChain(claim) : null;
}

// ── Poll loop ─────────────────────────────────────────────────────────────────
async function poll(): Promise<void> {
  const now = Math.floor(Date.now() / 1000);

  let total: number;
  try {
    total = await getClaimCount();
  } catch (err) {
    console.warn("[council] Failed to read the claim count:", err);
    return;
  }

  console.log(
    `\n[council] ── Poll at ${new Date().toISOString()} ── ${total} claims, ${ACTIVE_PERSONAS.length} personas`,
  );

  // Shared per-cycle evidence cache — one HTTP fetch per claim no matter
  // how many personas need it.
  const evidenceCache = new Map<number, EvidenceCacheEntry>();
  const peerReasoning = new Map<string, string[]>();
  const ctx: PersonaRunnerContext = {
    contractId: CONTRACT_ID,
    evidenceCache,
    peerReasoning,
  };

  // Pre-load joinable claims so we don't refetch in the inner loop.
  const allClaims: ClaimOnChain[] = [];
  for (let id = 1; id <= total; id++) {
    const claim = await fetchClaim(id);
    if (!claim) continue;
    const joinable = (claim.state === "open" || claim.state === "active") && claim.deadline > now;
    if (joinable) allClaims.push(claim);
  }
  if (allClaims.length === 0) {
    console.log("[council] No joinable claims this round.");
    return;
  }

  // Focus on claims closest to settling — they're the most interesting for
  // the council to weigh in on and keeps LLM-call volume bounded.
  allClaims.sort((a, b) => a.deadline - b.deadline);
  const claims = allClaims.slice(0, MAX_CLAIMS_PER_CYCLE);
  if (claims.length < allClaims.length) {
    console.log(
      `[council] Evaluating ${claims.length} of ${allClaims.length} joinable claims this cycle (deadline-prioritized).`,
    );
  }

  let stakesThisCycle = 0;

  for (const persona of ALL_ACTIVE) {
    for (const claim of claims) {
      try {
        if (PEER_READS_ENABLED && PEER_READS_PER_PERSONA > 0) {
          const reads = await buyPeerReasoning({
            buyer: persona,
            activePersonas: ALL_ACTIVE,
            claimId: claim.id,
            baseUrl: PEER_READS_BASE_URL,
            readsPerPersona: PEER_READS_PER_PERSONA,
            capUsdc: PEER_READ_CAP_USDC,
            delayMs: PEER_READ_DELAY_MS,
          });
          if (reads.length > 0) {
            const formattedReads = reads.map(
              (read) => `${read.sellerName}: ${read.reasoning}`,
            );
            peerReasoning.set(`${claim.id}:${persona.slug}`, formattedReads);
            const paidUsdc = reads.reduce(
              (sum, read) => sum + unitsToUsdc(BigInt(read.pricePaidUnits ?? "0")),
              0,
            );
            console.log(
              `[council:${persona.slug}] bought ${reads.length} peer read(s) for claim #${claim.id} ` +
              `(${paidUsdc.toFixed(6)} USDC)`,
            );
          }
        }
        const receipt = await runPersonaForClaim(persona, claim, ctx);
        if (receipt) stakesThisCycle += 1;
      } catch (err) {
        console.error(
          `[council:${persona.slug}] error on claim #${claim.id}:`,
          err instanceof Error ? err.message : err,
        );
      }
      if (DECISION_DELAY_MS > 0) {
        await new Promise((resolve) => setTimeout(resolve, DECISION_DELAY_MS));
      }
    }
  }

  console.log(
    stakesThisCycle > 0
      ? `[council] Cycle complete — ${stakesThisCycle} new stakes submitted.`
      : "[council] Cycle complete — no new stakes.",
  );
}

// ── Entry ─────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log("═══════════════════════════════════════════════");
  console.log("  Mimir Council — 10 AI personas as economic actors");
  console.log(`  Contract       : ${CONTRACT_ID}`);
  console.log(`  Network        : Stellar ${STELLAR_NETWORK}`);
  console.log(`  LLM            : ${activeLLMProvider()} / ${activeLLMModel()} · key=${activeLLMKeyFingerprint()}`);
  console.log(`  Active personas: ${ACTIVE_PERSONAS.length} / ${CLASSIC_PERSONAS.length}`);
  console.log(`  Philosophers   : ${PHILOSOPHERS_ENABLED ? `${ACTIVE_PHILOSOPHERS.length} / ${PHILOSOPHER_PERSONAS.length}` : "off"}`);
  console.log(`  Max claims/cycle: ${MAX_CLAIMS_PER_CYCLE}`);
  console.log(`  Decision gap   : ${DECISION_DELAY_MS / 1000}s`);
  console.log(`  Peer reads     : ${PEER_READS_ENABLED ? `${PEER_READS_PER_PERSONA}/persona via ${PEER_READS_BASE_URL}` : "off"}`);
  console.log(`  Peer read gap  : ${PEER_READ_DELAY_MS / 1000}s`);
  console.log(`  Poll every     : ${POLL_INTERVAL_MS / 1000}s`);
  console.log("───────────────────────────────────────────────");

  for (const p of ALL_ACTIVE) {
    // Public-key env differs per track, so ask the right one rather than assuming.
    const addr = (isPhilosopher(p)
      ? process.env[philosopherPublicEnv(p.slug)]
      : process.env[personaPublicEnv(p)])?.split(/\s+#/)[0].trim();
    if (!addr) {
      console.log(`  ${p.emoji} ${p.displayName.padEnd(22)} (no public key configured)`);
      continue;
    }
    // Both balances, because the two now answer different questions: XLM says
    // "can this persona transact at all", USDC says "can it stake".
    const balances = await readAgentBalances(addr).catch(() => null);
    const fees = balances?.xlm === null || balances === null ? "no account" : `${balances.xlm.toFixed(2)} XLM`;
    const bankroll = balances?.usdc == null ? "no USDC" : `${balances.usdc.toFixed(2)} USDC`;
    console.log(
      `  ${p.emoji} ${p.displayName.padEnd(22)} ${addr.slice(0, 5)}…${addr.slice(-4)} · ${fees} · ${bankroll}`,
    );
  }
  console.log("═══════════════════════════════════════════════\n");

  const safePoll = () =>
    reportingPoll("council", "council", POLL_INTERVAL_MS / 1000, poll, { pause: "council_worker" });

  await safePoll();
  setInterval(safePoll, POLL_INTERVAL_MS);
}

main().catch((err) => {
  console.error("[council] fatal:", err);
  process.exit(1);
});
