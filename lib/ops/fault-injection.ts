/**
 * Local-stack fault-injection profiles.
 *
 * Mimir ships money-moving features the same way it ships ops controls: the
 * fail-closed behavior is a contract, not a hope. A fault-injection profile is a
 * machine-readable runbook for one failure mode of the LOCAL stack — local
 * Postgres, mock Stellar, the API routes, and the worker fakes — so a developer
 * can reproduce the failure, watch the system refuse predictably, and know
 * exactly how to roll back.
 *
 * The rules that make this safe, in the same spirit as `lib/ops/flags.ts`:
 *
 *  1. **A fault may only ever DENY. It may never grant.** A profile exists to make
 *     something fail closed: DB reads crash, RPC reads fail, a paid endpoint
 *     refuses, a stale worker alarms. No profile may enable a gated money feature,
 *     unpause a capability, add a secret, or point any client at a non-loopback
 *     host. Injecting a fault that makes a denied action succeed would be a
 *     backdoor, so the validator rejects those environments outright.
 *  2. **Keep money where the chain is.** Profiles treat Stellar RPC/Horizon as
 *     the source of truth; a profile never makes the read-index cache authoritative.
 *  3. **Deterministic and secret-free.** Every profile pins an exact environment
 *     built only from `FAULTABLE_ENV_KEYS`, on loopback addresses only, with no
 *     production credentials. `buildFaultEnv()` reproduces the same environment on
 *     every run, so the check is reproducible from a clean checkout.
 *
 * This module is pure (no Node, no network, no process.env reads) so it can be
 * imported by the `node:test` suite and by the local runner
 * (`scripts/run-fault-injection-profile.ts`) without side effects.
 */

// ── The local stack ───────────────────────────────────────────────────────────

/**
 * The components a profile drives a fault into. These mirror what a developer
 * actually runs locally: a Postgres URL (local Postgres), the Stellar network
 * pointers (mock Stellar), the Next API routes, and the worker entrypoints
 * (worker fakes).
 */
export const FAULT_COMPONENTS = [
  "postgres",
  "stellar_rpc",
  "stellar_horizon",
  "api_route",
  "worker",
] as const;
export type FaultComponent = (typeof FAULT_COMPONENTS)[number];

export function isFaultComponent(value: string): value is FaultComponent {
  return (FAULT_COMPONENTS as readonly string[]).includes(value);
}

/** The shape of the injected failure. */
export const FAULT_KINDS = [
  // The dependency is configured-registered but nothing is listening.
  "unreachable",
  // The dependency is deliberately absent, so the app must boot in its unset
  // state and fail closed on the missing piece.
  "not_configured",
  // The dependency answers but with the wrong network identity.
  "wrong_passphrase",
  // A control is engaged so the operation refuses (a pause, a policy block).
  "refused",
  // A worker has stopped reporting, so health must call it out.
  "stale",
] as const;
export type FaultKind = (typeof FAULT_KINDS)[number];

export function isFaultKind(value: string): value is FaultKind {
  return (FAULT_KINDS as readonly string[]).includes(value);
}

/** What the profile is protecting. Money paths are the ones that must refuse. */
export const FAULT_CATEGORIES = ["money", "read", "ops"] as const;
export type FaultCategory = (typeof FAULT_CATEGORIES)[number];

export function isFaultCategory(value: string): value is FaultCategory {
  return (FAULT_CATEGORIES as readonly string[]).includes(value);
}

// ── What a profile may touch ──────────────────────────────────────────────────

/**
 * The ONLY environment keys a fault-injection profile may set or force-absent.
 *
 * This is the security boundary: anything not listed cannot be injected. A
 * profile may pause a money capability (a denial), but it may never enable a
 * gated feature, lift a pause, rotate a nonce-persistence flag, or hold a
 * secret-shaped value. If a new local fault needs a new key, it must be added
 * here deliberately, with the tests updated.
 */
export const FAULTABLE_ENV_KEYS = Object.freeze([
  "DATABASE_URL",
  "NEXT_PUBLIC_STELLAR_RPC_URL",
  "NEXT_PUBLIC_STELLAR_HORIZON_URL",
  "NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE",
  "X402_NETWORK",
  "MIMIR_PAUSE_X402_SELLING",
  "MIMIR_PAUSE_X402_SELLING_REASON",
  "MIMIR_PAUSE_STAKE",
  "MIMIR_PAUSE_STAKE_REASON",
  "MIMIR_PAUSE_ORACLE_SETTLEMENT",
  "MIMIR_PAUSE_ORACLE_SETTLEMENT_REASON",
  "NEXT_PUBLIC_STELLAR_MARKET_CONTRACT_ID",
  "NEXT_PUBLIC_STELLAR_SQUAD_CONTRACT_ID",
  "NEXT_PUBLIC_STELLAR_USDC_SAC_ID",
] as const);
export type FaultableEnvKey = (typeof FAULTABLE_ENV_KEYS)[number];

/** Keys that name a URL and are therefore forced to loopback during validation. */
const URL_SHAPED_KEYS = new Set([
  "DATABASE_URL",
  "NEXT_PUBLIC_STELLAR_RPC_URL",
  "NEXT_PUBLIC_STELLAR_HORIZON_URL",
]);

/** Capabilities a profile is allowed to pause (denial only, value must be "1"). */
const PAUSABLE = new Set([
  "MIMIR_PAUSE_X402_SELLING",
  "MIMIR_PAUSE_STAKE",
  "MIMIR_PAUSE_ORACLE_SETTLEMENT",
]);

// ── Profile shape ─────────────────────────────────────────────────────────────

/**
 * A profile's environment. A `""` value is a directive to FORCE the key ABSENT
 * (the `not_configured` faults), which `buildFaultEnv()` reports through `dropped`
 * rather than by setting an empty string.
 */
export type FaultProfileEnv = Readonly<Record<string, string>>;

export interface FaultProfile {
  /** Stable id, kebab-case. Referenced by the runner and the docs. */
  id: string;
  /** One line: what the fault is and which capability it protects. */
  summary: string;
  component: FaultComponent;
  fault: FaultKind;
  category: FaultCategory;
  /** Deterministic, secret-free environment for the injected fault. */
  env: FaultProfileEnv;
  /** Marker ids the fail-closed path MUST produce when the fault is injected. */
  expected: readonly string[];
  /** HTTP status a probe may assert on, when the fault maps onto an API route. */
  expectedHttp?: number;
  /** What actually happens to the local stack when this fault is present. */
  failure: string;
  /** How to undo the injection locally, and the operational rollback posture. */
  rollback: string;
  /** What the profile run leaves behind (artifacts). */
  artifacts: string;
  /** Always "none": no profile needs or permits production credentials. */
  secrets: "none";
}

// ── The registry ──────────────────────────────────────────────────────────────

/**
 * `<md>://` unreachable loopback used for every `unreachable` profile. Port 1 is
 * closed by convention, so a connection is refused immediately and deterministically
 * on every platform — nothing listens, nothing needs installing, no secrets.
 */
const REFUSED_LOOPBACK = "127.0.0.1:1";

/**
 * All supported local-stack fault profiles. Keep ids stable: docs, fixtures and
 * pasteable commands reference them.
 */
export const FAULT_PROFILES = Object.freeze({
  "db-not-configured": {
    id: "db-not-configured",
    summary: "DATABASE_URL is absent, so the app runs in its unconfigured read-index state.",
    component: "postgres",
    fault: "not_configured",
    category: "read",
    env: { DATABASE_URL: "" },
    expected: ["db.unconfigured"],
    expectedHttp: 503,
    failure:
      "The read-index routes and the /api/health probe fail closed: health returns 503 critical with a db.unconfigured alarm, and pages that need the index (explorer, dashboard, challenge opportunities) report their DB-dependent failure without touching the chain.",
    rollback:
      "Local: restore DATABASE_URL in .env.local and restart the app. Operational: there is nothing to roll back — this is exactly the shipped behavior of a build without the index.",
    artifacts:
      "Nothing durable; the runner prints the forced-absent DATABASE_URL and the observed marker.",
    secrets: "none",
  },
  "db-unreachable": {
    id: "db-unreachable",
    summary: "DATABASE_URL points at a loopback port that refuses connections.",
    component: "postgres",
    fault: "unreachable",
    category: "read",
    env: {
      DATABASE_URL: `postgres://fault:injected@${REFUSED_LOOPBACK}/mimir?sslmode=disable&connect_timeout=1`,
    },
    expected: ["db.claims_unreadable"],
    expectedHttp: 503,
    failure:
      "Health reads fail at the query layer (the settlement backlog cannot be read), so /api/health reports 503 critical with a db.claims_unreadable alarm. The read-index cache is down; the chain remains the source of truth and is not touched.",
    rollback:
      "Local: restore the real DATABASE_URL and restart. Operational: a real Neon outage produces the same alarm; warm the index from chain (npm run warm:vs-index) once the store is back, never the other way.",
    artifacts:
      "The runner prints the refused URL (a marker, not a credential) and the observed critical alarm.",
    secrets: "none",
  },
  "stellar-rpc-unreachable": {
    id: "stellar-rpc-unreachable",
    summary: "Soroban RPC is unreachable, so chain reads fail and money paths refuse.",
    component: "stellar_rpc",
    fault: "unreachable",
    category: "money",
    env: {
      NEXT_PUBLIC_STELLAR_RPC_URL: `http://${REFUSED_LOOPBACK}/rpc`,
      NEXT_PUBLIC_STELLAR_HORIZON_URL: `http://${REFUSED_LOOPBACK}/horizon`,
    },
    expected: ["rpc.unreachable"],
    failure:
      "Contract reads throw (market state is unknowable), the sync worker cannot warm the index, and any settlement or paid-endpoint path that must read the chain refuses rather than guessing. Chain-first accounting holds: nobody can move money against an RPC it cannot verify.",
    rollback:
      "Local: unset the two NEXT_PUBLIC_STELLAR_*_URL overrides (or point them back at the testnet provider) and restart. Operational: restore the provider endpoint; the app returns to trusting only a reachable ledger.",
    artifacts:
      "The runner prints the loopback URLs and the observed refusal from the RPC client.",
    secrets: "none",
  },
  "stellar-horizon-unreachable": {
    id: "stellar-horizon-unreachable",
    summary: "Horizon is unreachable, so x402 payment verification must refuse.",
    component: "stellar_horizon",
    fault: "unreachable",
    category: "money",
    env: { NEXT_PUBLIC_STELLAR_HORIZON_URL: `http://${REFUSED_LOOPBACK}/horizon` },
    expected: ["horizon_unavailable"],
    failure:
      "A verifier that cannot read the ledger must refuse: verifying a paid-endpoint proof fails with reason horizon_unavailable, so nothing is served for a payment the system cannot confirm landed. Unverified payments are never recorded as revenue.",
    rollback:
      "Local: unset the Horizon override and restart. Operational: restore the provider Horizon endpoint; verification resumes on the next request.",
    artifacts:
      "The runner prints the loopback URL and the refusal reason.",
    secrets: "none",
  },
  "stellar-passphrase-mismatch": {
    id: "stellar-passphrase-mismatch",
    summary: "The network passphrase/identity is wrong, so proofs bind to nothing.",
    component: "stellar_rpc",
    fault: "wrong_passphrase",
    category: "money",
    env: {
      NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE: "Fault-Injected Network Passphrase ; 2026",
      X402_NETWORK: "stellar:mismatch",
    },
    expected: ["network_mismatch"],
    failure:
      "Signatures are bound to a network passphrase. A proof naming one network is refused against a quote for another (network_mismatch), so a wrong identity cannot accidentally settle: payments and verdicts must agree on the exact network or nothing moves.",
    rollback:
      "Local: unset the two injected values so the Testnet passphrase and stellar:testnet apply again; restart the worker. Operational: correcting the network env re-binds all signing.",
    artifacts:
      "The runner prints the injected passphrase tag (never a secret) and the refusal reason.",
    secrets: "none",
  },
  "paid-seller-paused": {
    id: "paid-seller-paused",
    summary: "x402 selling is paused, so paid endpoints refuse new sales.",
    component: "api_route",
    fault: "refused",
    category: "money",
    env: {
      MIMIR_PAUSE_X402_SELLING: "1",
      MIMIR_PAUSE_X402_SELLING_REASON: "local fault-injection profile (x402 selling paused)",
    },
    expected: ["x402_selling"],
    failure:
      "Paid endpoints refuse with a 503/403 carrying the structured x402_selling capability and the operator reason. Reading stays up and settlement keeps working — a paused paid endpoint must not freeze payouts.",
    rollback:
      "Local: unset MIMIR_PAUSE_X402_SELLING (and its _REASON) and restart. Operational: unset the pause in the deployment env; selling resumes without a deploy.",
    artifacts:
      "The runbook prints the pause env; the probe asserts the gate enrolls capability x402_selling.",
    secrets: "none",
  },
  "chain-not-configured": {
    id: "chain-not-configured",
    summary: "No contract ids: the app boots in its chain-unconfigured state.",
    component: "api_route",
    fault: "not_configured",
    category: "money",
    env: {
      NEXT_PUBLIC_STELLAR_MARKET_CONTRACT_ID: "",
      NEXT_PUBLIC_STELLAR_SQUAD_CONTRACT_ID: "",
      NEXT_PUBLIC_STELLAR_USDC_SAC_ID: "",
    },
    expected: ["chain.unconfigured"],
    failure:
      "Without contract ids no chain address exists to read or write, so market reads fail deterministically and money paths are gated behind a connect control; the browser smoke suite pins exactly this state. Nothing can silently point at a real deployment.",
    rollback:
      "Local: this is the shipped default of a fresh checkout; run the deploy flow to reconfigure. Operational: restore the NEXT_PUBLIC_STELLAR_*_CONTRACT_ID env.",
    artifacts:
      "The runner prints that the contract ids resolve empty.",
    secrets: "none",
  },
  "worker-settlement-stale": {
    id: "worker-settlement-stale",
    summary: "The oracle worker has stopped reporting, so health calls it critical.",
    component: "worker",
    fault: "stale",
    category: "ops",
    env: {},
    expected: ["worker.oracle.stale", "settlement.overdue"],
    failure:
      "A worker that never reports (or reports stale) shows critical, and a market past its deadline and still unsettled alarms as settlement.overdue — absence of signal is health, not silence to ignore.",
    rollback:
      "Local: this profile simulates the stale heartbeat in-process; restart the worker to clear it. Operational: restart the oracle; the beats table is overwritten each cycle.",
    artifacts:
      "The runbook prints the simulated snapshot; the probe asserts the two alarm ids.",
    secrets: "none",
  },
} as const satisfies Record<string, FaultProfile>);

export type FaultProfileId = keyof typeof FAULT_PROFILES;

export const FAULT_PROFILE_IDS = Object.freeze(
  Object.keys(FAULT_PROFILES) as FaultProfileId[],
);

export function getAllFaultProfiles(): readonly FaultProfile[] {
  return FAULT_PROFILE_IDS.map((id) => FAULT_PROFILES[id]);
}

export function isKnownFaultProfile(id: string): boolean {
  return id in FAULT_PROFILES;
}

/**
 * Resolve a profile by id. Fails closed: an unknown id throws rather than
 * returning a partial or defaulted profile that a runner could execute silently.
 */
export function getFaultProfile(id: string): FaultProfile {
  if (!isKnownFaultProfile(id)) {
    throw new Error(`unknown fault-injection profile "${id}" — list with --list`);
  }
  return FAULT_PROFILES[id as FaultProfileId];
}

// ── Validation ────────────────────────────────────────────────────────────────

/** True when the host of `raw` is a loopback address. */
export function isLoopbackUrl(raw: string): boolean {
  try {
    const hostname = new URL(raw).hostname;
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
  } catch {
    return false;
  }
}

/**
 * Why a fault environment is unsafe, one issue per line. An injected fault must
 * only deny, never grant: any feature enable, pause lift, cryptic secret or
 * non-loopback host is rejected here.
 */
export function validateFaultEnv(env: FaultProfileEnv): string[] {
  const problems: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (!(FAULTABLE_ENV_KEYS as readonly string[]).includes(key)) {
      problems.push(
        `${key} is not faultable — a profile may only touch FAULTABLE_ENV_KEYS`,
      );
      continue;
    }
    if (value === "") continue; // forced-absent directive, handled by buildFaultEnv
    if (URL_SHAPED_KEYS.has(key)) {
      if (!isLoopbackUrl(value)) {
        problems.push(`${key} must point at loopback, got ${value}`);
      }
      continue;
    }
    if (PAUSABLE.has(key)) {
      // A fault may only ever pause — value "1". "0"/"false" would lift a control,
      // which an injection must never do.
      if (value !== "1") {
        problems.push(`${key} is a pause switch and a fault may only pause ("1")`);
      }
      continue;
    }
    // String-shaped values (passphrase, pause reason, network id) are free-form
    // but must not smuggle in a URL the loopback check would have missed.
    if (/^[a-z]+:\/\//i.test(value) && !isLoopbackUrl(value)) {
      problems.push(`${key} looks like a URL but does not point at loopback`);
    }
  }
  return problems;
}

/** Every failure-mode field a profile needs is present and well-typed. */
export function validateFaultProfile(profile: FaultProfile): string[] {
  const problems: string[] = [];
  if (!isKnownFaultProfile(profile.id)) {
    problems.push(`profile id "${profile.id}" is not registered in FAULT_PROFILES`);
  }
  if (!isFaultComponent(profile.component)) {
    problems.push(`${profile.component} is not a FAULT_COMPONENT`);
  }
  if (!isFaultKind(profile.fault)) {
    problems.push(`${profile.fault} is not a FAULT_KINDS value`);
  }
  if (!isFaultCategory(profile.category)) {
    problems.push(`${profile.category} is not a FAULT_CATEGORIES value`);
  }
  if (profile.expected.length === 0) {
    problems.push("expected must name at least one fail-closed marker");
  }
  if (profile.failure.trim().length === 0) {
    problems.push("failure must be described explicitly");
  }
  if (profile.rollback.trim().length === 0) {
    problems.push("rollback must be described explicitly");
  }
  if (profile.artifacts.trim().length === 0) {
    problems.push("artifacts must be described explicitly");
  }
  if (profile.secrets !== "none") {
    problems.push("fault-injection profiles must never hold or require secrets");
  }
  problems.push(...validateFaultEnv(profile.env));
  return problems;
}

// ── Building the deterministic environment ────────────────────────────────────

export interface FaultEnvResult {
  /** The exact environment to run under. Contains only FAULTABLE_ENV_KEYS. */
  env: Record<string, string>;
  /**
   * Keys the profile FORCES absent. Entries with a `""` value in the profile's
   * `env` become `dropped` members rather than empty strings in `env`.
   */
  dropped: string[];
}

/**
 * Build the deterministic environment for a profile: the profile's env minus the
 * forced-absent keys. Pure and stable, so a runner and its regression test agree
 * byte-for-byte.
 */
export function buildFaultEnv(profile: FaultProfile): FaultEnvResult {
  const problems = validateFaultProfile(profile);
  if (problems.length > 0) {
    throw new Error(
      `refusing to build the environment for "${profile.id}": ${problems.join("; ")}`,
    );
  }
  const env: Record<string, string> = {};
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(profile.env)) {
    if (value === "") {
      dropped.push(key);
    } else {
      env[key] = value;
    }
  }
  return { env, dropped };
}

// ── Evaluating a probe ────────────────────────────────────────────────────────

/**
 * Check an observed failure against the profile's contract. `observedIds` are the
 * marker ids the local stack actually produced (alarm ids, refusal reasons,
 * gated capability ids); a probe passes only when every required marker is
 * present — an empty observation is a silent bypass and a failure.
 */
export function evaluateFaultProbe(
  profile: FaultProfile,
  observedIds: readonly string[],
  observedHttp?: number,
): { pass: boolean; missing: readonly string[] } {
  const observed = new Set(observedIds);
  const missing = profile.expected.filter((marker) => !observed.has(marker));
  // When a profile documents an HTTP status, the probe must match it too — the
  // health route's 503 is part of the fail-closed contract, not a detail.
  const statusMismatch =
    profile.expectedHttp !== undefined &&
    observedHttp !== undefined &&
    observedHttp !== profile.expectedHttp;
  return { pass: missing.length === 0 && !statusMismatch, missing };
}

/**
 * The explicit runbook: failure, rollback, artifacts, secrets and environment —
 * the five things the issue asks to define per profile, machine-readable.
 */
export function faultProfileRunbook(profile: FaultProfile) {
  const built = buildFaultEnv(profile);
  return {
    id: profile.id,
    summary: profile.summary,
    component: profile.component,
    fault: profile.fault,
    category: profile.category,
    environment: { env: built.env, forcedAbsent: built.dropped },
    expected: profile.expected,
    expectedHttp: profile.expectedHttp,
    failure: profile.failure,
    rollback: profile.rollback,
    artifacts: profile.artifacts,
    secrets: profile.secrets as "none",
  };
}
