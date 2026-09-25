/**
 * Regression tests for the browser smoke environment harness.
 *
 * The browser smoke flow builds and serves the app with a strict secret-free
 * allowlist (scripts/lib/browser-smoke-env.mjs). These tests pin the contract
 * that makes that flow deterministic: secrets are never inherited, chain
 * configuration stays absent so the app boots "not configured", and the files
 * Next.js reads are exactly the ones the harness moves aside. If an engineer
 * adds a new NEXT_PUBLIC_STELLAR_* var the app needs at build time, these tests
 * force them to decide explicitly whether the smoke build pins it.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  SMOKE_ALLOWLIST,
  SMOKE_NEXT_PUBLIC,
  SECRET_KEY_PATTERNS,
  buildSmokeEnv,
  isLikelyCi,
  smokeEnvFileNames,
} from "../../scripts/lib/browser-smoke-env.mjs";

const SECRET_SAMPLES = [
  "STELLAR_ORACLE_SECRET",
  "STELLAR_ORACLE_PRIVATE_KEY",
  "DEMO_CREATOR_SECRET",
  "DEMO_CREATOR_STELLAR_SECRET",
  "DATABASE_URL",
  "GEMINI_API_KEY",
  "ANALYTICS_POSTHOG_KEY",
  "ANALYTICS_ACTOR_SALT",
  "NODE_AUTH_TOKEN",
];

const CHAIN_SAMPLES = [
  "NEXT_PUBLIC_STELLAR_MARKET_CONTRACT_ID",
  "NEXT_PUBLIC_STELLAR_SQUAD_CONTRACT_ID",
  "NEXT_PUBLIC_STELLAR_USDC_SAC_ID",
  "NEXT_PUBLIC_STELLAR_USDC_ISSUER",
  "RPC_URL",
  "HORIZON_URL",
  "FRIENDBOT_URL",
];

function parentEnvWithSecrets(): Record<string, string> {
  const parent: Record<string, string> = { PATH: "/usr/bin", HOME: "/home/test" };
  for (const key of [...SECRET_SAMPLES, ...CHAIN_SAMPLES]) parent[key] = "leaked-value";
  return parent;
}

test("SMOKE_ALLOWLIST is the only route into a smoke env: secrets never pass", () => {
  const env = buildSmokeEnv(parentEnvWithSecrets());
  for (const key of SECRET_SAMPLES) {
    assert.equal(
      key in env,
      false,
      `secret ${key} must never be copied into the smoke env`,
    );
  }
  assert.equal(env.DATABASE_URL, undefined);
});

test("chain and contract configuration stays absent so the app boots unconfigured", () => {
  const env = buildSmokeEnv(parentEnvWithSecrets());
  for (const key of CHAIN_SAMPLES) {
    assert.equal(
      key in env,
      false,
      `chain key ${key} must stay unset in the smoke env`,
    );
  }
  // Nothing but the pinned NEXT_PUBLIC whitelist is allowed at all.
  const leakedPublic = Object.keys(env).filter(
    (key) => key.startsWith("NEXT_PUBLIC_") && !(key in SMOKE_NEXT_PUBLIC),
  );
  assert.deepEqual(leakedPublic, []);
});

test("the deterministic NEXT_PUBLIC block is pinned", () => {
  const env = buildSmokeEnv({});
  assert.equal(env.NEXT_PUBLIC_STELLAR_NETWORK, "testnet");
  assert.equal(
    env.NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE,
    "Test SDF Network ; September 2015",
  );
});

test("process plumbing is inherited but CI stays passive", () => {
  const env = buildSmokeEnv({ PATH: "/bin", HOME: "/h" });
  assert.equal(env.PATH, "/bin");
  assert.equal(env.HOME, "/h");
  assert.equal(env.CI, "0");
  const ciEnv = buildSmokeEnv({ PATH: "/bin", CI: "true" });
  assert.equal(ciEnv.CI, "true");
  assert.equal(isLikelyCi({ CI: "true" }), true);
  assert.equal(isLikelyCi({ CI: "1" }), true);
  assert.equal(isLikelyCi({ GITHUB_ACTIONS: "true" }), true);
  assert.equal(isLikelyCi({}), false);
});

test("telemetry is always disabled for a local, reproducible build", () => {
  assert.equal(buildSmokeEnv({}).NEXT_TELEMETRY_DISABLED, "1");
  // A developer's own setting may never override the harness.
  assert.equal(
    buildSmokeEnv({ NEXT_TELEMETRY_DISABLED: "0" }).NEXT_TELEMETRY_DISABLED,
    "1",
  );
});

test("the env files moved aside are exactly the ones Next.js reads", () => {
  assert.deepEqual(smokeEnvFileNames(), [
    ".env.production.local",
    ".env.local",
    ".env.production",
    ".env",
  ]);
});

test("every secret-flagging pattern is anchored to a name in SECRET_KEY_PATTERNS", () => {
  // Sanity: the heuristic that flags "secret-named" keys behaves on the
  // samples the harness documents. Looseness is fine here (over-matching on
  // *names* for diagnostics is acceptable), but never under-matching a real
  // server secret name.
  for (const key of SECRET_SAMPLES) {
    assert.ok(
      SECRET_KEY_PATTERNS.some((pattern) => pattern.test(key)),
      `expected "${key}" to be flagged by SECRET_KEY_PATTERNS`,
    );
  }
  // Chain ids deliberately are not secrets.
  for (const key of CHAIN_SAMPLES) {
    assert.ok(
      !SMOKE_ALLOWLIST.includes(key),
      `"${key}" must not be allowlisted`,
    );
  }
});

test("a build with an empty parent still produces a runnable env", () => {
  const env = buildSmokeEnv({});
  assert.ok(Object.keys(env).length > 0);
  assert.equal(env.NEXT_PUBLIC_STELLAR_NETWORK, "testnet");
});