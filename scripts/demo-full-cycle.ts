/**
 * End-to-end demo of the full Mimir cycle on Stellar Testnet, with an LLM
 * settling. Stakes are USDC through its Stellar Asset Contract; fees are XLM.
 *
 *   1. market-creator wallet  → create_claim (2 USDC stake, 150s deadline)
 *   2. oracle wallet          → challenge_claim (2 USDC counter-stake)
 *   3. wait for the deadline
 *   4. oracle wallet (LLM)    → resolve_claim
 *   5. oracle wallet          → claim_challenger_payout (the NEW pull step)
 *
 * Run: npx tsx --env-file-if-exists=.env.local scripts/demo-full-cycle.ts
 *
 * ── Three things the EVM version did that no longer apply ───────────────────
 *
 *  1. **No approve.** There is no allowance leg: `create_claim` and
 *     `challenge_claim` carry auth for exactly one USDC transfer of exactly the
 *     stake, so `amountUsdc` had nothing left to pre-authorise.
 *  2. **The claim id comes back from the call.** `create_claim` returns it, so the
 *     old "read `claimCount` afterwards and hope nobody else created one in
 *     between" step is gone.
 *  3. **Resolution does not pay the challengers.** A Stellar transaction is capped
 *     on its ledger-entry footprint, so `resolve_claim` escrows and each
 *     challenger pulls. A demo that stopped at step 4 would show a settled market
 *     with no money moved, which is why step 5 exists.
 */

import {
  challengeClaim,
  claimChallengerPayout,
  createClaim,
  quoteChallengerPayout,
  resolveClaim,
} from "../lib/contract";
import { getCreatorWallet, getOracleWallet, readAgentBalances } from "../lib/agent-wallets";
import { evidenceCommitmentHash } from "../lib/evidence-commitment";
import { callLLM, activeLLMProvider, activeLLMModel } from "../lib/llm";
import { isVerdict, type Verdict } from "../lib/verdict";
import { requireMarketContractId } from "../lib/stellar";
import { USDC_ASSET } from "../lib/usdc";

const DEADLINE_SECONDS = 150;
const STAKE_USDC = 2;
const PRICE_URL = "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd";

const VERDICT_TO_SIDE = {
  CREATOR_WINS: "creator",
  CHALLENGERS_WIN: "challengers",
  DRAW: "draw",
  UNRESOLVABLE: "unresolvable",
} as const;

async function main(): Promise<void> {
  const contractId = requireMarketContractId();
  const oracle = getOracleWallet();
  const creator = getCreatorWallet();

  console.log("─── Mimir full-cycle demo (Stellar Testnet, USDC stakes) ───");
  console.log(`Contract: ${contractId}`);
  console.log(`USDC    : ${USDC_ASSET}`);
  console.log(`LLM     : ${activeLLMProvider()} / ${activeLLMModel()}`);
  console.log(`Creator : ${creator.address}`);
  console.log(`Oracle  : ${oracle.address}`);

  const deadline = Math.floor(Date.now() / 1000) + DEADLINE_SECONDS;

  // 1. CREATE
  console.log(`\n[1/5] Creating claim (deadline in ${DEADLINE_SECONDS}s, stake ${STAKE_USDC} USDC)…`);
  const created = await createClaim(creator.signer, {
    question: "Mimir demo — is the Bitcoin price > $100,000 USD?",
    creator_position: "Yes, BTC > $100k",
    counter_position: "No, BTC ≤ $100k",
    resolution_url: PRICE_URL,
    deadline,
    stake_amount: STAKE_USDC,
    category: "crypto",
    settlement_rule: "Settle from CoinGecko BTC USD spot price at deadline",
    max_challengers: 100,
  });
  const claimId = created.claimId;
  if (claimId === null) throw new Error("create_claim did not return a claim id");
  console.log(`  create tx: ${created.explorerUrl ?? created.txHash}`);
  console.log(`  claim id : #${claimId}`);

  // 2. CHALLENGE
  console.log(`\n[2/5] Oracle challenges (stakes ${STAKE_USDC} USDC on Side B)…`);
  const challenged = await challengeClaim(oracle.signer, claimId, STAKE_USDC);
  console.log(`  challenge tx: ${challenged.explorerUrl ?? challenged.txHash}`);

  // 3. WAIT
  const waitMs = (DEADLINE_SECONDS + 5) * 1000;
  console.log(`\n[3/5] Waiting ${Math.ceil(waitMs / 1000)}s for the deadline…`);
  await new Promise((resolve) => setTimeout(resolve, waitMs));

  // 4. RESOLVE
  console.log(`\n[4/5] Oracle resolving via LLM…`);
  const evidenceFetchedAt = Date.now();
  const evidence = await (await fetch(PRICE_URL)).text();
  // Use the canonical evidence commitment (length-framed, versioned) so the
  // demo hash matches what the oracle agent commits in production and can be
  // independently verified against the source bytes.
  const evidenceHash = evidenceCommitmentHash({
    evidence,
    fetcher: "coingecko-api",
    sourceUrl: PRICE_URL,
    fetchedAt: evidenceFetchedAt,
    now: Date.now(),
  });

  const llm = await callLLM(
    `Claim: Will BTC price be above $100,000 USD?\nEvidence JSON: ${evidence.slice(0, 500)}\n` +
      `Reply JSON only: {"verdict":"CREATOR_WINS"|"CHALLENGERS_WIN"|"DRAW"|"UNRESOLVABLE","confidence":0-100,"explanation":"..."}`,
  );
  let verdict: Verdict = "UNRESOLVABLE";
  let confidence = 50;
  let summary = "Demo settlement";
  try {
    const parsed = JSON.parse(llm.match(/\{[\s\S]*\}/)?.[0] ?? "{}");
    if (isVerdict(parsed.verdict)) verdict = parsed.verdict;
    confidence = Math.max(0, Math.min(100, Number(parsed.confidence ?? confidence)));
    summary = String(parsed.explanation ?? summary).slice(0, 200);
  } catch {
    /* use defaults */
  }

  const resolved = await resolveClaim(oracle.signer, claimId, {
    winner_side: VERDICT_TO_SIDE[verdict],
    summary,
    confidence,
    evidence_hash: evidenceHash,
  });
  console.log(`  resolve tx: ${resolved.explorerUrl ?? resolved.txHash}`);
  console.log(`  verdict   : ${verdict} (${confidence}%)`);

  // 5. PULL — the settlement step that has no EVM counterpart.
  console.log(`\n[5/5] Oracle pulls its challenger settlement…`);
  const quote = await quoteChallengerPayout(claimId, oracle.address);
  if (!quote || quote.claimed || quote.net <= 0) {
    console.log(
      `  nothing to pull (${verdict} — the creator side won, or the escrow is already drawn down)`,
    );
  } else {
    console.log(`  quote: ${quote.gross} gross − ${quote.fee} fee = ${quote.net} USDC`);
    const pulled = await claimChallengerPayout(oracle.signer, claimId);
    console.log(`  payout tx: ${pulled.explorerUrl ?? pulled.txHash}  (+${pulled.netPayout} USDC)`);
  }

  const [creatorBalances, oracleBalances] = await Promise.all([
    readAgentBalances(creator.address),
    readAgentBalances(oracle.address),
  ]);

  console.log("\n─── Done ───");
  console.log(
    `Creator USDC : ${(creatorBalances.usdc ?? 0).toFixed(4)}  fees ${(creatorBalances.xlm ?? 0).toFixed(4)} XLM`,
  );
  console.log(
    `Oracle  USDC : ${(oracleBalances.usdc ?? 0).toFixed(4)}  fees ${(oracleBalances.xlm ?? 0).toFixed(4)} XLM`,
  );
}

main().catch((error) => {
  console.error("demo-full-cycle failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
