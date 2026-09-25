/**
 * Reproducible load test for x402 Stellar payment-proof verification and its
 * replay limits — entirely offline, deterministic on every run.
 *
 * It synthesizes a quote, mints as many landed payments as you ask for on an
 * in-memory ledger, signs a real proof for each (the fixture payer's key), and
 * verifies plus settles them through the SAME code a live worker runs — the
 * facilitator, the certificate check, the (here fixture) Horizon reader and the
 * replay guard. The load exemption: it never touches a network and never spends
 * money, so it can run in CI without funding.
 *
 *   npm run load:x402                                # 1,000 verifications
 *   npm run load:x402 -- --count 5000 --concurrency 200
 *
 * Every correctness invariant is checked, and the run exits non-zero if any of
 * them breaks. The numbers that matter to a human are the throughput rows.
 */

import { ExactStellarFacilitator } from "../lib/x402/stellar-scheme";
import {
  fakeHorizonBackend,
  landedPayment,
  makeRequirements,
  runX402Load,
  settleFixtures,
  signedProof,
  toPaymentPayload,
} from "../tests/node/x402-fixtures";

function arg(name: string, fallback: number): number {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? Number(process.argv[index + 1] ?? NaN) : NaN;
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

const COUNT = arg("--count", 1_000);
const CONCURRENCY = arg("--concurrency", 50);
const MAX_AGE_MS = arg("--max-age-ms", 5 * 60 * 1000);

let failures = 0;

function check(label: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

async function main(): Promise<void> {
  settleFixtures.reset();
  console.log(`x402 verification load — ${COUNT} payments, concurrency ${CONCURRENCY}`);
  console.log("");

  const stats = await runX402Load({ count: COUNT, concurrency: CONCURRENCY, maxAgeMs: MAX_AGE_MS });

  check(`verified ${stats.verifiedOk}/${COUNT}`, stats.verifiedOk === COUNT);
  check(`settled ${stats.settledOk}/${COUNT}`, stats.settledOk === COUNT);
  check(`replays refused ${stats.replaysRefused}/${COUNT}`, stats.replaysRefused === COUNT);
  check("exactly one transaction read per proof", stats.txReads === COUNT, `${stats.txReads} reads`);
  check("exactly one operations read per proof", stats.opsReads === COUNT, `${stats.opsReads} reads`);
  check("replay set holds exactly the settled hashes", stats.consumedAfter === COUNT);

  console.log("");
  console.log(
    `  verified/s : ${stats.verificationsPerSecond.toFixed(0).padStart(9)}   settled/s: ${(stats.settledOk / (stats.durationMs / 1000)).toFixed(0).padStart(9)}`,
  );
  console.log(`  duration   : ${stats.durationMs.toFixed(0).padStart(11)} ms   (${COUNT} proofs)`);
  console.log("");

  // Post-hoc replay gate through the real facilitator: a sample of the hashes
  // that just settled must not buy a second response.
  const requirements = makeRequirements();
  const backend = fakeHorizonBackend(
    stats.transactions.map((transaction) => landedPayment({ transaction })),
  );
  const facilitator = new ExactStellarFacilitator(backend);
  const sampleSize = Math.min(20, stats.transactions.length);
  let replaysAllowed = 0;
  for (const transaction of stats.transactions.slice(0, sampleSize)) {
    const payload = toPaymentPayload(signedProof(transaction, requirements), requirements);
    const replay = await facilitator.settle(payload, requirements);
    if (replay.success) replaysAllowed += 1;
  }
  check(
    `the facilitator refuses ${sampleSize}/${sampleSize} replayed proofs`,
    replaysAllowed === 0,
    replaysAllowed > 0 ? `${replaysAllowed} replayed proof(s) were allowed` : "",
  );

  if (failures > 0) {
    console.error(`\n✗ ${failures} invariant(s) failed; the load envelope is broken.`);
    process.exitCode = 1;
  } else {
    console.log("✓ envelope holds — every proof verified, settled, and refused exactly once.");
  }
}

main().catch((error) => {
  console.error(`✗ load run crashed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});