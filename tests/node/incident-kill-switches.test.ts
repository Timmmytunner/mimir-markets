/**
 * Every incident kill switch, exercised at the point where it is enforced.
 *
 * `ops-flags.test.ts` covers the flag arithmetic. This file covers the wiring: for
 * each capability in PAUSABLE there is a probe that drives the real call site —
 * the contract write, the paid-route gate, the worker loop, the agent route
 * policy — and reports whether the pause stopped it. The probe table is typed as
 * `Record<Pausable, Probe>`, so adding a capability without wiring and probing it
 * fails typecheck before it can ship as a switch that does nothing.
 *
 * Nothing here touches a network, a database or a secret. Contract writes run in
 * demo mode against a stubbed `fetch`, so "refused" means "refused before the
 * relay was called", not "the relay happened to be down".
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import { agentActionPauseGate, AGENT_ACTION_PAUSE, AGENT_API_ACTIONS } from "../../lib/agents/api";
import {
  cancelClaim,
  challengeClaim,
  claimChallengerPayout,
  claimFees,
  createClaim,
  createRematch,
  createSquadMarket,
  resolveClaim,
  squadClaim,
  squadDeposit,
  squadWithdrawBeforeDeadline,
  withdraw,
} from "../../lib/contract";
import {
  copyPolicyHash,
  evaluateCopy,
  type CopyExecutionContext,
  type CopyPermission,
  type CopySignal,
} from "../../lib/copy-trading";
import { reportingPoll } from "../../lib/ops/heartbeat";
import { PAUSABLE, pauseEnvKey, type Pausable } from "../../lib/ops/flags";
import { gatewayFetch } from "../../lib/research/gateway";
import { fetchWithBudget, type PayingWallet } from "../../lib/x402/buyer";
import { sellingPausedResponse } from "../../lib/x402/kill-switch";

type Env = Record<string, string | undefined>;

// ── Environment isolation ─────────────────────────────────────────────────────

/** Every variable a probe can be influenced by, cleared before each test. */
function isSwitchVar(key: string): boolean {
  return (
    key.startsWith("MIMIR_PAUSE") ||
    key === "MIMIR_PAUSED_X402_BUYERS" ||
    key === "RESEARCH_PAUSED_AGENT_IDS" ||
    key === "NEXT_PUBLIC_DEMO_MODE" ||
    key === "DATABASE_URL"
  );
}

let savedEnv: Env = {};
const realFetch = globalThis.fetch;
let relayCalls = 0;

beforeEach(() => {
  savedEnv = {};
  for (const key of Object.keys(process.env)) {
    if (isSwitchVar(key)) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  }
  // Demo mode routes every contract write through `/api/demo/write`. Stubbing it
  // makes "the write went through" observable and keeps the suite offline.
  process.env.NEXT_PUBLIC_DEMO_MODE = "1";
  relayCalls = 0;
  globalThis.fetch = (async () => {
    relayCalls += 1;
    return Response.json({ txHash: "", pending: false, claimId: 1 });
  }) as typeof fetch;
});

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (isSwitchVar(key)) delete process.env[key];
  }
  Object.assign(process.env, savedEnv);
  globalThis.fetch = realFetch;
});

function setEnv(env: Env): void {
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const USDC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const MIMIR = "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI";
const OWNER = "GBMGZBFKUNOS7JWPRPF5IMZR27DCR6BEP6SQVFV2I354UPY35FZTIR2Y";
const BUYER = "GDFSCDT3PNEMF4IS5HMWQ6E6SG5MUVBKTPKUJC45VGU2V232PSJYP3KP";
const UNIT = 10_000_000n;
const NOW = 1_780_000_000_000;

const CREATE_PARAMS = {
  question: "Will the fixture resolve?",
  creator_position: "Yes",
  counter_position: "No",
  resolution_url: "https://example.com/source",
  deadline: 4_100_000_000,
  stake_amount: 5,
} as unknown as Parameters<typeof createClaim>[1];

function copyPermission(): CopyPermission {
  const base = {
    permissionId: "perm-ks", ownerWallet: OWNER, executionAgentId: "agent-b", signalAgentId: "agent-a",
    maxPerPositionUsdc: 5, dailyCapUsdc: 10, weeklyCapUsdc: 30, totalOpenExposureUsdc: 20,
    maxRealizedLossAtomic: String(15n * UNIT), allowedCategories: ["crypto"], allowedModes: ["pool"],
    minConfidenceBps: 7000, minPayoutBps: 12000, expiresAt: NOW + 60_000, depth: 1 as const,
    status: "active" as const,
    spendPermission: { token: USDC, spender: MIMIR, allowanceAtomic: 10n * UNIT, periodSeconds: 86400 },
  };
  return { ...base, signedPolicyHash: copyPolicyHash(base) };
}

function copySignal(): CopySignal {
  return {
    sourcePositionId: "pos-a-1", signalAgentId: "agent-a", sourceDepth: 0, claimId: 7,
    category: "crypto", mode: "pool", confidenceBps: 8000, payoutBps: 15000, stakeUsdc: 3,
    deadline: NOW + 30_000, remainingSlots: 2, availableLiquidityUsdc: 10,
    requiredLiquidityUsdc: 3, sourceAttributionId: "attr-a-1",
  };
}

function copyContext(overrides: Partial<CopyExecutionContext> = {}): CopyExecutionContext {
  return {
    now: NOW, globalPaused: false,
    usage: { usedTodayUsdc: 0, usedThisWeekUsdc: 0, openExposureUsdc: 0, realizedLossAtomic: "0" },
    existingClaimIds: new Set(), ancestryAgentIds: ["agent-a"], configuredUsdc: USDC,
    configuredSpender: MIMIR, onchainAllowanceAtomic: 10n * UNIT,
    simulation: { ok: true, blockNumber: 100n }, ...overrides,
  };
}

const PAUSE_MESSAGE = /temporarily paused|is paused|paused/;

/** Run a contract write; "refused" only if it failed on the pause AND never reached the relay. */
async function contractWrite(write: () => Promise<unknown>): Promise<Outcome> {
  const before = relayCalls;
  try {
    await write();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (PAUSE_MESSAGE.test(message)) {
      assert.equal(relayCalls, before, `refused write still reached the relay: ${message}`);
      return "refused";
    }
    throw error;
  }
  assert.equal(relayCalls, before + 1, "an allowed demo write must reach the relay exactly once");
  return "passed";
}

async function workerCycle(worker: "market_creator" | "council", pause: Pausable): Promise<Outcome> {
  let cycles = 0;
  await reportingPoll(worker, `test-${worker}`, 60, async () => { cycles += 1; }, { pause });
  return cycles === 0 ? "refused" : "passed";
}

let researchSeq = 0;

// ── One probe per switch ──────────────────────────────────────────────────────

type Outcome = "refused" | "passed";
type Probe = () => Promise<Outcome>;

/**
 * Drives the real enforcement point for each capability. Typed as a full Record
 * so a new entry in PAUSABLE does not compile until it has a probe here.
 */
const PROBES: Record<Pausable, Probe> = {
  create_market: () => contractWrite(() => createClaim(null as never, CREATE_PARAMS)),
  stake: () => contractWrite(() => challengeClaim(null as never, 1, 5)),
  oracle_settlement: () => contractWrite(() => resolveClaim(null as never, 1)),

  copy_execution: async () => {
    const verdict = evaluateCopy(copyPermission(), copySignal(), copyContext());
    return !verdict.allowed && verdict.reason === "global_paused" ? "refused" : "passed";
  },

  x402_selling: async () => (sellingPausedResponse() ? "refused" : "passed"),

  x402_buying: async () => {
    // A wallet whose client factory records use: a refused purchase must stop
    // before a paying client exists, because on Stellar the buyer submits its
    // own payment and there is no later point to stop it.
    let clientsBuilt = 0;
    const wallet: PayingWallet = {
      address: BUYER,
      newClient: () => { clientsBuilt += 1; throw new Error("probe: client built"); },
    };
    try {
      await fetchWithBudget("https://seller.invalid/paid", wallet, 1n);
    } catch (error) {
      if (/x402 buying paused/.test((error as Error).message)) {
        assert.equal(clientsBuilt, 0);
        return "refused";
      }
    }
    assert.equal(clientsBuilt, 1);
    return "passed";
  },

  agent_registration: async () => (agentActionPauseGate("register").allowed ? "passed" : "refused"),

  market_creator_worker: () => workerCycle("market_creator", "market_creator_worker"),
  council_worker: () => workerCycle("council", "council_worker"),

  research: async () => {
    let fetches = 0;
    researchSeq += 1;
    const result = await gatewayFetch({
      // Unique URL and agent per call, so neither the cache nor a budget decides.
      url: `https://example.com/kill-switch-${researchSeq}`,
      agentId: `ks-agent-${researchSeq}`,
      resolve: async () => ["93.184.216.34"],
      fetchImpl: (async () => {
        fetches += 1;
        return new Response("ok", { headers: { "content-type": "text/plain" } });
      }) as typeof fetch,
    });
    if (!result.ok && result.kind === "paused") {
      assert.equal(fetches, 0, "a paused research call must not reach the source");
      return "refused";
    }
    assert.equal(fetches, 1);
    return "passed";
  },
};

// ── The matrix ────────────────────────────────────────────────────────────────

test("every pausable capability has a probe, and no probe is for a phantom switch", () => {
  assert.deepEqual(Object.keys(PROBES).sort(), [...PAUSABLE].sort());
});

for (const capability of PAUSABLE) {
  test(`${capability}: runs when nothing is paused`, async () => {
    // Negative control. Without it a probe that always says "refused" would pass
    // every other test in this file.
    assert.equal(await PROBES[capability](), "passed");
  });

  test(`${capability}: stopped by ${pauseEnvKey(capability)}=1`, async () => {
    setEnv({ [pauseEnvKey(capability)]: "1" });
    assert.equal(await PROBES[capability](), "refused");
  });

  test(`${capability}: stopped by MIMIR_PAUSE_ALL=1`, async () => {
    setEnv({ MIMIR_PAUSE_ALL: "1" });
    assert.equal(await PROBES[capability](), "refused");
  });

  test(`${capability}: pausing it leaves every other capability running`, async () => {
    setEnv({ [pauseEnvKey(capability)]: "1" });
    for (const other of PAUSABLE) {
      if (other === capability) continue;
      assert.equal(await PROBES[other](), "passed", `pausing ${capability} also stopped ${other}`);
    }
  });
}

test("only the exact value \"1\" pauses, so a typo fails open to the documented default", async () => {
  // Deliberate and pinned: the switches are opt-in stops, and every value other
  // than "1" is a no-op. An operator must use "1"; the runbook says so.
  for (const value of ["true", "yes", "0", ""]) {
    setEnv({ MIMIR_PAUSE_STAKE: value });
    assert.equal(await PROBES.stake(), "passed", `MIMIR_PAUSE_STAKE=${JSON.stringify(value)}`);
  }
});

// ── Regressions for gaps this suite found ─────────────────────────────────────

test("regression: a stake pause stops the demo relay, not only direct signing", async () => {
  // challengeClaim used to return through the demo relay before checking the
  // switch, and the relay signs with a funded server key.
  setEnv({ MIMIR_PAUSE_STAKE: "1" });
  await assert.rejects(challengeClaim(null as never, 1, 5), /stake is temporarily paused/);
  assert.equal(relayCalls, 0);
});

test("regression: a create pause stops rematches on the demo relay", async () => {
  setEnv({ MIMIR_PAUSE_CREATE_MARKET: "1" });
  await assert.rejects(
    createRematch(null as never, 1, { deadline: 4_100_000_000, stake_amount: 5 }),
    /create market is temporarily paused/,
  );
  assert.equal(relayCalls, 0);
});

test("regression: squad pools obey the create and stake switches", async () => {
  delete process.env.NEXT_PUBLIC_DEMO_MODE;
  setEnv({ MIMIR_PAUSE_CREATE_MARKET: "1" });
  await assert.rejects(createSquadMarket(null as never, { question: "q", deadline: 1, fee_bps: 0 }), PAUSE_MESSAGE);
  setEnv({ MIMIR_PAUSE_CREATE_MARKET: undefined, MIMIR_PAUSE_STAKE: "1" });
  await assert.rejects(squadDeposit(null as never, 1, 1, 5), PAUSE_MESSAGE);
});

test("regression: MIMIR_PAUSE_ALL reaches x402 buying and research", async () => {
  // Both used to read their own variable directly and ignored the global switch.
  setEnv({ MIMIR_PAUSE_ALL: "1" });
  assert.equal(await PROBES.x402_buying(), "refused");
  assert.equal(await PROBES.research(), "refused");
});

test("regression: copy execution honours the switch even when the caller passes globalPaused=false", () => {
  const verdict = evaluateCopy(
    copyPermission(), copySignal(),
    copyContext({ globalPaused: false, env: { MIMIR_PAUSE_COPY_EXECUTION: "1" } }),
  );
  assert.deepEqual(verdict, { allowed: false, reason: "global_paused" });
});

// ── What must never stop ──────────────────────────────────────────────────────

test("exit paths have no switch: withdraw, payouts, fee claims, squad exits and cancel", async () => {
  // With everything paused, each of these must fail only for the reason it would
  // fail anyway in this test (no signer) — never because of a pause. Users must
  // be able to pull funds out mid-incident.
  delete process.env.NEXT_PUBLIC_DEMO_MODE;
  setEnv({ MIMIR_PAUSE_ALL: "1", MIMIR_PAUSE_REASON: "incident in progress" });
  const exits: Array<[string, () => Promise<unknown>]> = [
    ["withdraw", () => withdraw(null as never)],
    ["claimChallengerPayout", () => claimChallengerPayout(null as never, 1)],
    ["claimFees", () => claimFees(null as never)],
    ["squadClaim", () => squadClaim(null as never, 1, 1)],
    ["squadWithdrawBeforeDeadline", () => squadWithdrawBeforeDeadline(null as never, 1, 1, 1)],
    ["cancelClaim", () => cancelClaim(null as never, 1)],
  ];
  for (const [name, exit] of exits) {
    await assert.rejects(exit(), (error: Error) => {
      assert.doesNotMatch(error.message, /paused|incident in progress/, `${name} was blocked by a pause`);
      assert.match(error.message, /no Stellar wallet signer/, `${name} failed for an unexpected reason`);
      return true;
    });
  }
});

test("agent revocation, reads, dry runs and proposals are never paused", () => {
  // Revocation is how an owner contains a compromised agent, so it has to work
  // during exactly the incident that would pause everything else.
  const env: Env = { MIMIR_PAUSE_ALL: "1" };
  const unswitched = AGENT_API_ACTIONS.filter((action) => !(action in AGENT_ACTION_PAUSE));
  for (const action of ["revoke", "revokeKey", "revokeSpend", "dryRun", "proposeMarket", "heartbeat"] as const) {
    assert.ok(unswitched.includes(action), `${action} must not have a switch`);
    assert.equal(agentActionPauseGate(action, env).allowed, true, `${action} was paused`);
  }
});

test("funded agent actions map to the switch for the money they move", () => {
  assert.deepEqual(AGENT_ACTION_PAUSE, {
    register: "agent_registration",
    createMarket: "create_market",
    stake: "stake",
    vote: "stake",
  });
  assert.equal(agentActionPauseGate("vote", { MIMIR_PAUSE_STAKE: "1" }).allowed, false);
  assert.equal(agentActionPauseGate("createMarket", { MIMIR_PAUSE_STAKE: "1" }).allowed, true);
});

// ── Failures are actionable and privacy-safe ──────────────────────────────────

test("a refusal names the capability and carries the operator's reason, nothing else", async () => {
  setEnv({ MIMIR_PAUSE_STAKE: "1", MIMIR_PAUSE_STAKE_REASON: "payout preview mismatch" });
  await assert.rejects(challengeClaim(null as never, 1, 5), /^Error: payout preview mismatch$/);

  setEnv({ MIMIR_PAUSE_STAKE_REASON: undefined });
  await assert.rejects(challengeClaim(null as never, 1, 5), /^Error: stake is temporarily paused$/);
});

test("the paid-route refusal is a retryable 503, not a 402 an agent would try to pay", () => {
  setEnv({ MIMIR_PAUSE_X402_SELLING: "1" });
  const response = sellingPausedResponse();
  assert.ok(response);
  assert.equal(response.status, 503);
  assert.equal(response.headers["retry-after"], "60");
  assert.match(response.body.detail ?? "", /x402 selling is temporarily paused/);
  // The body carries no env names, addresses or keys — only the public detail.
  assert.doesNotMatch(JSON.stringify(response.body), /MIMIR_|G[A-Z2-7]{55}|secret/i);
});

test("a paused worker keeps its process and does not report the stop as a failure", async () => {
  // Exiting would trip `npm run workers`' --kill-others-on-fail and take every
  // other worker down; throwing would page as a crash.
  setEnv({ MIMIR_PAUSE_COUNCIL_WORKER: "1", MIMIR_PAUSE_REASON: "LLM provider incident" });
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.join(" ")); };
  try {
    await assert.doesNotReject(workerCycle("council", "council_worker"));
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /paused by MIMIR_PAUSE_COUNCIL_WORKER, skipping this cycle: LLM provider incident/);
});

test("the worker log attributes a global pause to MIMIR_PAUSE_ALL", async () => {
  setEnv({ MIMIR_PAUSE_ALL: "1" });
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.join(" ")); };
  try {
    await workerCycle("market_creator", "market_creator_worker");
  } finally {
    console.warn = originalWarn;
  }
  assert.match(warnings[0] ?? "", /paused by MIMIR_PAUSE_ALL/);
});

test("clearing a switch resumes the capability on the next call, with no restart state", async () => {
  // Rollback is unsetting the variable. Nothing is cached across calls, so the
  // first call after the flip goes through.
  setEnv({ MIMIR_PAUSE_ORACLE_SETTLEMENT: "1" });
  assert.equal(await PROBES.oracle_settlement(), "refused");
  setEnv({ MIMIR_PAUSE_ORACLE_SETTLEMENT: undefined });
  assert.equal(await PROBES.oracle_settlement(), "passed");
});
