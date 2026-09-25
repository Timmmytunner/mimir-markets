/**
 * Deterministic environment for the browser smoke flow.
 *
 * The smoke flow builds and serves the app with a strict allowlist instead of
 * the developer's real environment. Anything not on the allowlist is dropped,
 * so a `.env.local`, a `.env`, or an exported shell variable can never reach a
 * smoke run. This is fail-closed by construction:
 *
 *   - secrets (oracle signer, demo signers, DB URL, analytics salts, …) are
 *     never inherited;
 *   - chain/contract configuration is deliberately absent, so the app runs in
 *     its "unconfigured chain" state and the tests assert it fails closed
 *     instead of silently pointing at a real deployment;
 *   - NEXT_PUBLIC_* values that the browser bundle bakes in at build time are
 *     pinned to deterministic values.
 *
 * Keep this module free of Node-specific imports (it only reads objects and
 * strings) so it can be imported from plain Node scripts and from the
 * `node:test` suite.
 */

/** Non-secret environment variables the smoke run may inherit from the parent. */
export const SMOKE_ALLOWLIST = Object.freeze([
  // Process basics required to build, run node, and spawn a browser.
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TZ",
  "TMPDIR",
  "TEMP",
  "TMP",
  // CI identification: an action that runs in CI may print slightly different
  // hints, and reporters may want to know. Nothing sensitive lives here.
  "CI",
  "GITHUB_ACTIONS",
  "GITHUB_SHA",
  "GITHUB_REF",
  "GITHUB_REF_NAME",
  "GITHUB_RUN_ID",
  "GITHUB_JOB",
  "GITHUB_WORKFLOW",
  "GITHUB_REPOSITORY",
  "GITHUB_SERVER_URL",
  "GITHUB_WORKSPACE",
  // Node/Next plumbing that keeps output readable but carries no credentials.
  "NODE_OPTIONS",
  "NEXT_TELEMETRY_DISABLED",
]);

/**
 * NEXT_PUBLIC_* values pinned into the browser bundle. These are the only
 * public env vars a smoke run may bake in. Contract ids, RPC endpooints,
 * Horizon URLs and any `NEXT_PUBLIC_*` key not listed here stay unset: the
 * smoke build must ship the "chain not configured" state, not a real one.
 */
export const SMOKE_NEXT_PUBLIC = Object.freeze({
  NEXT_PUBLIC_STELLAR_NETWORK: "testnet",
  NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
});

/**
 * The `.env*` files Next.js reads during a production build and `next start`.
 * `.env.local` and `.env.production.local` are never used when
 * `NODE_ENV !== test`, and plain `.env` would be read too, so every one of them
 * is moved aside for the duration of a smoke run and restored afterwards. A
 * developer's real configuration can never leak into the served app.
 *
 * Order matters only for reporting; Next reads the most specific file first.
 */
export function smokeEnvFileNames() {
  return [".env.production.local", ".env.local", ".env.production", ".env"];
}

/**
 * Build the process environment for a smoke build/serve/test run.
 *
 * Starts from the parent environment but keeps only allowlisted keys, then pins
 * the deterministic next-public values. Never copies or filters the parent's
 * values into anything wider than SMOKE_ALLOWLIST.
 *
 * @param {Record<string, string | undefined>} [parentEnv] default `process.env`
 * @returns {Record<string, string | undefined>}
 */
export function buildSmokeEnv(parentEnv = process.env) {
  const env = {};
  for (const key of SMOKE_ALLOWLIST) {
    if (parentEnv[key] !== undefined) {
      env[key] = parentEnv[key];
    }
  }
  // CI markers: when already present the parent value is kept; otherwise
  // default to "not CI" so local runs behave identically everywhere.
  if (env.CI === undefined) env.CI = "0";
  env.NEXT_TELEMETRY_DISABLED = "1";
  for (const [key, value] of Object.entries(SMOKE_NEXT_PUBLIC)) {
    env[key] = value;
  }
  return env;
}

/**
 * True when the parent looks like a CI runner. Used by the orchestrator to
 * decide whether a missing browser is a hard error.
 *
 * @param {Record<string, string | undefined>} [parentEnv] default `process.env`
 * @returns {boolean}
 */
export function isLikelyCi(parentEnv = process.env) {
  return parentEnv.CI === "true" || parentEnv.CI === "1" || Boolean(parentEnv.GITHUB_ACTIONS);
}

// Known secret-shaped environment variable names, used only for diagnostics and
// the regression test: a crash or a leak is far easier to debug when the harness
// can say "I saw a secret-named key and dropped it".
export const SECRET_KEY_PATTERNS = Object.freeze([
  /^STELLAR_.*(SECRET|PRIVATE|SEED|SIGNER)/i,
  /^DEMO_.*SECRET/i,
  /^.*(SECRET|PRIVATE_KEY|PRIVATE|PASSPHRASE|SALT|KEY|TOKEN|API_KEY|SIGNING_KEY).*$/i,
  /^DATABASE_URL$/i,
]);