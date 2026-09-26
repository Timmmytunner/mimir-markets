/**
 * Local fault-injection profile runner.
 *
 * Prints the machine-readable runbook for one or more profiles, evaluates the
 * in-process parts of each probe (pause-gate, worker-stale, env-build
 * invariants), and exits non-zero if any probe fails.
 *
 * NO network, NO database, NO secrets — fully reproducible from a clean
 * checkout. Profiles that involve a live HTTP server (e.g. stellar-rpc-unreachable)
 * print their injection environment and expected markers for manual verification;
 * the in-process invariants (env validation, loopback guard, deny-only rule) are
 * still checked mechanically.
 *
 * Usage:
 *
 *   npm run fault:profile                          # list all profiles
 *   npm run fault:profile -- --list                # same
 *   npm run fault:profile -- --profile db-not-configured
 *   npm run fault:profile -- --all
 *   npm run fault:profile -- --category money
 *   npm run fault:profile -- --profile paid-seller-paused --json
 *
 * Exit codes:
 *   0  — all selected profiles passed their in-process probes
 *   1  — one or more probes failed, or an unknown profile id was supplied
 */

import {
  FAULT_PROFILE_IDS,
  FAULT_CATEGORIES,
  getAllFaultProfiles,
  getFaultProfile,
  buildFaultEnv,
  evaluateFaultProbe,
  faultProfileRunbook,
  validateFaultProfile,
  type FaultCategory,
  type FaultProfile,
} from "../lib/ops/fault-injection";
import { pauseState, isPaused, type Pausable } from "../lib/ops/flags";
import {
  evaluateHealth,
  DEFAULT_THRESHOLDS,
  type HealthSnapshot,
  type WorkerBeat,
} from "../lib/ops/health";

// ── CLI argument parsing ──────────────────────────────────────────────────────

const argv = process.argv.slice(2);

function flag(name: string): boolean {
  return argv.includes(name);
}

function option(name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

const LIST = flag("--list") || argv.length === 0;
const ALL = flag("--all");
const JSON_OUT = flag("--json");
const PROFILE_ID = option("--profile");
const CATEGORY_RAW = option("--category");

if (CATEGORY_RAW && !(FAULT_CATEGORIES as readonly string[]).includes(CATEGORY_RAW)) {
  console.error(
    `unknown category "${CATEGORY_RAW}". Valid categories: ${FAULT_CATEGORIES.join(", ")}`,
  );
  process.exit(1);
}
const CATEGORY = CATEGORY_RAW as FaultCategory | undefined;

// ── Helpers ───────────────────────────────────────────────────────────────────

function pad(s: string, n: number): string {
  return s.padEnd(n);
}

function printList(): void {
  console.log("Fault-injection profiles:\n");
  const profiles = getAllFaultProfiles();
  const idWidth = Math.max(...profiles.map((p) => p.id.length));
  for (const p of profiles) {
    console.log(`  ${pad(p.id, idWidth)}  [${p.category}/${p.fault}]  ${p.summary}`);
  }
  console.log(`\n${profiles.length} profiles. Run with --profile <id> or --all.`);
}

// ── In-process probe implementations ─────────────────────────────────────────

/**
 * The in-process portion of each probe.  For most profiles this validates that:
 *  - the env builds without error and validates clean
 *  - every URL-shaped key is loopback-only
 *  - deny-only rule: pause keys are "1"
 *
 * For profiles that can be fully evaluated in-process (pause gates, worker
 * heartbeat simulation), the real evaluators are exercised so the runner
 * produces the same check the test suite does.
 */
function runInProcessProbe(profile: FaultProfile): {
  pass: boolean;
  issues: string[];
  observedIds: string[];
} {
  const issues: string[] = [];
  const observedIds: string[] = [];

  // 1. Profile must validate structurally
  const structureProblems = validateFaultProfile(profile);
  if (structureProblems.length > 0) {
    issues.push(...structureProblems.map((p) => `validation: ${p}`));
    return { pass: false, issues, observedIds };
  }

  // 2. Environment builds without throwing
  let built: ReturnType<typeof buildFaultEnv>;
  try {
    built = buildFaultEnv(profile);
  } catch (err) {
    issues.push(
      `buildFaultEnv threw: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { pass: false, issues, observedIds };
  }

  // 3. Pause-gate profiles: verify the real isPaused/pauseState evaluators agree
  if (profile.id === "paid-seller-paused") {
    const capability: Pausable = "x402_selling";
    const state = pauseState(capability, built.env);
    if (!state.paused) {
      issues.push("isPaused(x402_selling) must be true under injected env");
    } else {
      observedIds.push("x402_selling"); // the expected marker
    }
    if (!isPaused(capability, built.env)) {
      issues.push("isPaused helper disagrees with pauseState");
    }
    if (!state.reason || state.reason.trim().length === 0) {
      issues.push("a money pause must carry an operator reason");
    }
  }

  // 4. Worker-stale profile: simulate the stale heartbeat with the real evaluator
  if (profile.id === "worker-settlement-stale") {
    const nowMs = Date.now();
    const staleWorker: WorkerBeat = {
      name: "oracle",
      lastBeatAtMs: nowMs - 2 * 3_600_000, // 2 hours stale
      expectedIntervalSec: 900,
    };
    const freshWorker: WorkerBeat = {
      name: "ledger",
      lastBeatAtMs: nowMs - 20_000,
      expectedIntervalSec: 900,
    };
    const snapshot: HealthSnapshot = {
      workers: [staleWorker, freshWorker],
      indexLastSyncAgeSec: 10,
      oldestQueuedJobAgeSec: 5,
      oldestOverdueSettlementSec: 2 * 3_600, // 2 hours overdue
      oracleBacklog: 3,
      rpc: { failures: 0, attempts: 40 },
      facilitator: { failures: 0, attempts: 40 },
      sources: { failures: 0, attempts: 40 },
    };
    const report = evaluateHealth(snapshot, nowMs, DEFAULT_THRESHOLDS);
    for (const alarm of report.alarms) {
      observedIds.push(alarm.id);
    }
  }

  // 5. For all other profiles the expected markers are environment-delivery
  //    markers that require a live server. We confirm the profile is consistent
  //    and the environment is safe, but do not claim the server-side probe
  //    passed — the runner documents what to observe manually instead.
  const serverSideProfiles = new Set([
    "db-not-configured",
    "db-unreachable",
    "stellar-rpc-unreachable",
    "stellar-horizon-unreachable",
    "stellar-passphrase-mismatch",
    "chain-not-configured",
  ]);

  if (serverSideProfiles.has(profile.id)) {
    // Mark as passed for server-side profiles: the in-process checks (steps 1-2)
    // are the mechanically verifiable parts; the full round-trip is manual.
    return { pass: issues.length === 0, issues, observedIds: [] };
  }

  // For in-process profiles, evaluate the probe
  const probe = evaluateFaultProbe(profile, observedIds);
  if (!probe.pass) {
    issues.push(`probe missing markers: ${probe.missing.join(", ")}`);
  }

  return { pass: issues.length === 0 && probe.pass, issues, observedIds };
}

// ── Profile output ────────────────────────────────────────────────────────────

function printRunbook(profile: FaultProfile, result: ReturnType<typeof runInProcessProbe>): void {
  const runbook = faultProfileRunbook(profile);
  const status = result.pass ? "✓" : "✗";

  if (JSON_OUT) {
    console.log(JSON.stringify({ ...runbook, probeResult: result }, null, 2));
    return;
  }

  console.log(`\n── ${status} ${profile.id} ──`);
  console.log(`  ${profile.summary}`);
  console.log(`  component : ${profile.component}`);
  console.log(`  fault     : ${profile.fault}`);
  console.log(`  category  : ${profile.category}`);
  console.log(`  expected  : ${profile.expected.join(", ")}`);
  if (profile.expectedHttp !== undefined) {
    console.log(`  http      : ${profile.expectedHttp}`);
  }

  // Environment section
  const { env, forcedAbsent } = runbook.environment;
  if (Object.keys(env).length > 0 || forcedAbsent.length > 0) {
    console.log(`  env:`);
    for (const [k, v] of Object.entries(env)) {
      console.log(`    ${k}=${v}`);
    }
    for (const k of forcedAbsent) {
      console.log(`    ${k}=(forced absent)`);
    }
  } else {
    console.log(`  env       : (no overrides — simulated in-process)`);
  }

  console.log(`\n  failure   : ${profile.failure}`);
  console.log(`  rollback  : ${profile.rollback}`);
  console.log(`  artifacts : ${profile.artifacts}`);
  console.log(`  secrets   : ${profile.secrets}`);

  if (result.observedIds.length > 0) {
    console.log(`\n  observed  : ${result.observedIds.join(", ")}`);
  }

  if (!result.pass) {
    console.log(`\n  ✗ probe issues:`);
    for (const issue of result.issues) {
      console.log(`    - ${issue}`);
    }
  } else {
    const serverSide = new Set([
      "db-not-configured", "db-unreachable", "stellar-rpc-unreachable",
      "stellar-horizon-unreachable", "stellar-passphrase-mismatch", "chain-not-configured",
    ]);
    if (serverSide.has(profile.id)) {
      console.log(
        `\n  ✓ env + structure pass. Full round-trip requires a running dev server`,
      );
      console.log(
        `    (inject the env above, run npm run dev, and assert the markers manually).`,
      );
    } else {
      console.log(`\n  ✓ in-process probe passed`);
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

function selectProfiles(): FaultProfile[] {
  if (PROFILE_ID) {
    // Validate up front so a typo exits immediately
    try {
      return [getFaultProfile(PROFILE_ID)];
    } catch (err) {
      console.error(`${err instanceof Error ? err.message : String(err)}`);
      console.error(`\nAvailable profiles:\n  ${FAULT_PROFILE_IDS.join("\n  ")}`);
      process.exit(1);
    }
  }
  const all = getAllFaultProfiles();
  if (CATEGORY) return all.filter((p) => p.category === CATEGORY);
  if (ALL) return [...all];
  return [];
}

function main(): void {
  if (LIST && !ALL && !PROFILE_ID && !CATEGORY) {
    printList();
    process.exit(0);
  }

  const profiles = selectProfiles();
  if (profiles.length === 0) {
    printList();
    process.exit(0);
  }

  if (!JSON_OUT) {
    console.log(`Running ${profiles.length} fault-injection profile(s)…`);
  }

  let failures = 0;
  for (const profile of profiles) {
    const result = runInProcessProbe(profile);
    printRunbook(profile, result);
    if (!result.pass) failures += 1;
  }

  if (!JSON_OUT) {
    console.log(
      `\n${profiles.length - failures}/${profiles.length} profile(s) passed in-process probes.`,
    );
  }

  if (failures > 0) {
    if (!JSON_OUT) {
      console.error(`\n✗ ${failures} profile(s) failed. See above for details.`);
    }
    process.exit(1);
  }
}

main();
