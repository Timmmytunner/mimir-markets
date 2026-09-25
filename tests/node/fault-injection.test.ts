import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  getAllFaultProfiles,
  getFaultProfile,
  isKnownFaultProfile,
  isLoopbackUrl,
  validateFaultProfile,
  validateFaultEnv,
  buildFaultEnv,
  evaluateFaultProbe,
  faultProfileRunbook,
} from "../../lib/ops/fault-injection";
import { pauseState, isPaused, type Pausable } from "../../lib/ops/flags";
import {
  evaluateHealth,
  DEFAULT_THRESHOLDS,
  type HealthSnapshot,
  type WorkerBeat,
} from "../../lib/ops/health";

test("fault injection: the registry is a stable, loopback-only, secret-free contract", () => {
  const profiles = getAllFaultProfiles();
  assert.ok(profiles.length >= 8, `expected >= 8 profiles, got ${profiles.length}`);

  for (const profile of profiles) {
    assert.equal(profile.secrets, "none", `${profile.id}: a profile must never carry secrets`);
    assert.ok(profile.expected.length > 0, `${profile.id}: must name fail-closed markers`);
    assert.ok(profile.summary.trim().length > 0, `${profile.id}: needs a summary`);
    assert.ok(profile.failure.trim().length > 0, `${profile.id}: needs an explicit failure`);
    assert.ok(profile.rollback.trim().length > 0, `${profile.id}: needs an explicit rollback`);
    assert.equal(validateFaultProfile(profile).length, 0, `${profile.id}: must validate clean`);
    assert.ok(isKnownFaultProfile(profile.id), `${profile.id}: must be a known profile id`);
    assert.equal(getFaultProfile(profile.id).id, profile.id, `${profile.id}: must round-trip by id`);

    const URL_SHAPED_KEYS = new Set([
      "DATABASE_URL",
      "NEXT_PUBLIC_STELLAR_RPC_URL",
      "NEXT_PUBLIC_STELLAR_HORIZON_URL",
    ]);
    for (const [key, value] of Object.entries(profile.env)) {
      if (!URL_SHAPED_KEYS.has(key)) continue; // non-URL keys (passphrase, network) are not hosts
      if (value === "") continue; // forced-absent directive, not a host
      assert.ok(isLoopbackUrl(value), `${profile.id}: ${key} must be loopback-only, got ${value}`);
    }
    assert.ok(validateFaultEnv(buildFaultEnv(profile).env).length === 0, `${profile.id}: built env must validate`);
  }
});

test("fault injection: a money pause can only DENY — and it must flip the real x402 selling gate", () => {
  const profile = getFaultProfile("paid-seller-paused");
  const selling: Pausable = "x402_selling";
  const built = buildFaultEnv(profile);
  const state = pauseState(selling, built.env);
  assert.equal(state.paused, true, "the injected pause must flip the real x402 selling gate");
  assert.ok(state.reason !== undefined && state.reason.trim().length > 0, "a money pause must carry an operator reason");
  assert.equal(isPaused(selling, built.env), true, "isPaused must agree with the pause state");
});

test("fault injection: the worker-settlement-stale probe passes only with the real criticals", () => {
  const profile = getFaultProfile("worker-settlement-stale");
  const nowMs = 1_800_000_000_000;
  const staleWorker: WorkerBeat = {
    name: "oracle",
    lastBeatAtMs: nowMs - 2 * 3_600_000,
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
    oldestOverdueSettlementSec: 2 * 3_600,
    oracleBacklog: 3,
    rpc: { failures: 0, attempts: 40 },
    facilitator: { failures: 0, attempts: 40 },
    sources: { failures: 0, attempts: 40 },
  };
  const report = evaluateHealth(snapshot, nowMs, DEFAULT_THRESHOLDS);
  const observedIds = report.alarms.map((a) => a.id);

  for (const marker of profile.expected) {
    assert.ok(observedIds.includes(marker), `worker-settlement-stale: expected ${marker} observed`);
  }
  const probe = evaluateFaultProbe(profile, observedIds);
  assert.equal(probe.pass, true, "the worker-settlement-stale probe must pass with the real criticals");
});

test("fault injection: every profile carries a machine-readable runbook", () => {
  for (const profile of getAllFaultProfiles()) {
    const runbook = faultProfileRunbook(profile);
    assert.equal(runbook.id, profile.id, "runbook must key by profile id");
    assert.equal(runbook.secrets, "none", `${profile.id}: runbook must declare no secrets`);
    assert.ok(runbook.environment.env, `${profile.id}: runbook must pin an environment`);
  }
});
