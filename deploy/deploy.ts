/**
 * Deploy `mimir-market` + `mimir-squad` to Stellar Testnet.
 *
 * Replaces the previous EVM/solc deploy entirely. Shells out to the
 * `stellar` CLI (25.x) rather than assembling Soroban transactions by hand: the
 * CLI already does WASM upload, footprint simulation, resource-fee bumping and
 * XDR-typed argument conversion, all of which are fiddly and version-sensitive
 * to reimplement.
 *
 * Steps:
 *   1. Build both contracts (skippable with --no-build).
 *   2. Derive the Soroban Asset Contract id for Circle's Testnet USDC and prove
 *      the SAC instance is live by reading `decimals` off it.
 *   3. Deploy each WASM, capturing its contract id.
 *   4. `initialize` mimir-market (owner/oracle/usdc + fee policy) and
 *      mimir-squad (usdc/oracle/fee_recipient).
 *   5. Persist ids to `.env.local` (gitignored).
 *
 *   npx tsx deploy/deploy.ts
 *   npx tsx deploy/deploy.ts --no-build          # reuse existing target/ wasm
 *   npx tsx deploy/deploy.ts --force-redeploy    # ignore ids already in .env.local
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

import {
  ENV_KEYS,
  MAX_TOTAL_FEE_BPS,
  NETWORK,
  NETWORK_PASSPHRASE,
  REPO_ROOT,
  SOROBAN_RPC_URL,
  USDC_ASSET,
  USDC_DECIMALS,
  USDC_ISSUER,
  envValue,
  explorerContractUrl,
  requireEnv,
  writeEnvLocal,
} from "../scripts/lib/stellar-env";

import {
  formatProvenanceReport,
  verifyRepoArtifactProvenance,
} from "../lib/ops/artifact-provenance";

const CONTRACTS_DIR = path.join(REPO_ROOT, "contracts-soroban");
const WASM_DIR = path.join(CONTRACTS_DIR, "target", "wasm32v1-none", "release");

const args = new Set(process.argv.slice(2));
const skipBuild = args.has("--no-build");
const forceRedeploy = args.has("--force-redeploy");

/**
 * Starting fee policy. `platform_fee_bps + agent_owner_fee_bps` must stay at or
 * under `MAX_TOTAL_FEE_BPS` (1_000 = 10%) from
 * `contracts-soroban/mimir-market/src/types.rs`. 2% platform, no agent-owner fee
 * yet: agent attribution is per-claim (`CreateParams.agent_owner_recipient`) and
 * is not wired up in this phase.
 */
const PLATFORM_FEE_BPS = Number(envValue(ENV_KEYS.platformFeeBps) ?? 200);
const AGENT_OWNER_FEE_BPS = Number(envValue(ENV_KEYS.agentOwnerFeeBps) ?? 0);

/** mimir-squad's own per-market cap, `MAX_FEE_BPS` in its types.rs, also 1_000. */
const SQUAD_MAX_FEE_BPS = 1_000;

interface Deployable {
  key: "market" | "squad";
  label: string;
  wasm: string;
  envKey: string;
}

const DEPLOYABLES: Deployable[] = [
  {
    key: "market",
    label: "mimir-market",
    wasm: path.join(WASM_DIR, "mimir_market.wasm"),
    envKey: ENV_KEYS.marketId,
  },
  {
    key: "squad",
    label: "mimir-squad",
    wasm: path.join(WASM_DIR, "mimir_squad.wasm"),
    envKey: ENV_KEYS.squadId,
  },
];

// ── CLI plumbing ─────────────────────────────────────────────────────────────

/**
 * Run the `stellar` CLI and return trimmed stdout. Secrets arrive via
 * `--source-account` and would otherwise show up in an error dump, so the
 * command echo is redacted.
 */
export function runStellar(cliArgs: string[], options: { quiet?: boolean } = {}): string {
  const redacted = cliArgs.map((arg) => (/^S[A-Z2-7]{55}$/.test(arg) ? "S***(secret)" : arg));
  if (!options.quiet) console.log(`    $ stellar ${redacted.join(" ")}`);
  const result = spawnSync("stellar", cliArgs, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: {
      ...process.env,
      STELLAR_NETWORK: NETWORK,
      STELLAR_RPC_URL: SOROBAN_RPC_URL,
      STELLAR_NETWORK_PASSPHRASE: NETWORK_PASSPHRASE,
    },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `stellar ${redacted.join(" ")} exited ${result.status}\n${result.stderr ?? ""}\n${result.stdout ?? ""}`,
    );
  }
  return (result.stdout ?? "").trim();
}

const NETWORK_FLAGS = ["--network", NETWORK, "--rpc-url", SOROBAN_RPC_URL, "--network-passphrase", NETWORK_PASSPHRASE];

/**
 * `Option<T>` arguments must be passed as JSON, unlike their bare `T`
 * counterparts. `stellar contract invoke -- initialize --help` advertises a bare
 * `G...` for `Option<Address>`, but the CLI (25.1.0) actually rejects it with
 * "Invalid JSON in argument". A JSON string literal is what it wants.
 */
function optionArg(value: string): string {
  return JSON.stringify(value);
}

// ── Steps ────────────────────────────────────────────────────────────────────

function buildContracts(): void {
  if (skipBuild) {
    console.log("[1/5] build skipped (--no-build)");
    return;
  }
  console.log("[1/5] building contracts (wasm32v1-none)…");
  const result = spawnSync("stellar", ["contract", "build"], {
    cwd: CONTRACTS_DIR,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(`stellar contract build failed\n${result.stderr ?? ""}`);
  }
  console.log("    ✓ build complete");
}

function assertWasmPresent(): void {
  for (const target of DEPLOYABLES) {
    if (!existsSync(target.wasm)) {
      throw new Error(`missing ${target.wasm} — run without --no-build`);
    }
  }
}

/** Derive the USDC SAC id and prove the instance is live on testnet. */
function resolveUsdcSac(deployerSecret: string): string {
  console.log("[2/5] resolving USDC Stellar Asset Contract…");
  const sacId = runStellar(["contract", "id", "asset", "--asset", USDC_ASSET, ...NETWORK_FLAGS]);
  if (!/^C[A-Z2-7]{55}$/.test(sacId)) throw new Error(`unexpected SAC id: ${sacId}`);

  // `contract id asset` is pure derivation — it does not prove the SAC instance
  // exists. A read-only invoke does.
  const decimals = runStellar([
    "contract",
    "invoke",
    "--id",
    sacId,
    "--source-account",
    deployerSecret,
    "--send",
    "no",
    ...NETWORK_FLAGS,
    "--",
    "decimals",
  ]);
  if (Number(decimals) !== USDC_DECIMALS) {
    throw new Error(
      `USDC SAC reports ${decimals} decimals but the contracts require ${USDC_DECIMALS} ` +
        `(USDC_DECIMALS in contracts-soroban/*/src/types.rs; initialize would reject it) — ` +
        `stop and reconcile before deploying`,
    );
  }
  console.log(`    ✓ SAC ${sacId} live, decimals=${decimals}`);
  return sacId;
}

function deployWasm(target: Deployable, deployerSecret: string): string {
  const existing = forceRedeploy ? undefined : envValue(target.envKey);
  if (existing) {
    console.log(`    ${target.label}: reusing ${existing} from .env.local`);
    return existing;
  }
  const contractId = runStellar([
    "contract",
    "deploy",
    "--wasm",
    target.wasm,
    "--source-account",
    deployerSecret,
    ...NETWORK_FLAGS,
  ])
    .split(/\s+/)
    .filter((token) => /^C[A-Z2-7]{55}$/.test(token))
    .pop();
  if (!contractId) throw new Error(`could not parse a contract id out of the ${target.label} deploy`);
  // Persist immediately: a failure in the initialize step below must not orphan a
  // contract that already cost a real testnet deploy.
  writeEnvLocal(
    { [target.envKey]: contractId },
    { header: "# ── Mimir Soroban contracts (written by deploy/deploy.ts) ──" },
  );
  console.log(`    ✓ ${target.label} → ${contractId}`);
  return contractId;
}

/**
 * Both contracts guard `initialize` with a one-shot `AlreadyInitialized`, so a
 * re-run against an already-initialized instance is reported and skipped rather
 * than treated as a failure.
 */
function invokeInitialize(label: string, contractId: string, deployerSecret: string, fnArgs: string[]): void {
  const result = spawnSync(
    "stellar",
    [
      "contract",
      "invoke",
      "--id",
      contractId,
      "--source-account",
      deployerSecret,
      ...NETWORK_FLAGS,
      "--",
      "initialize",
      ...fnArgs,
    ],
    { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  const combined = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.status === 0) {
    console.log(`    ✓ ${label} initialize succeeded`);
    return;
  }
  if (/AlreadyInitialized|Error\(Contract, #1\)/.test(combined)) {
    console.log(`    • ${label} already initialized — leaving existing state alone`);
    return;
  }
  throw new Error(`${label} initialize failed (exit ${result.status})\n${combined}`);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const deployerSecret = requireEnv(ENV_KEYS.deployerSecret, "run: npx tsx scripts/stellar-keys.ts");
  const deployerPublic = requireEnv(ENV_KEYS.deployerPublic, "run: npx tsx scripts/stellar-keys.ts");
  const oraclePublic = requireEnv(ENV_KEYS.oraclePublic, "run: npx tsx scripts/stellar-keys.ts");

  if (
    !Number.isInteger(PLATFORM_FEE_BPS) ||
    !Number.isInteger(AGENT_OWNER_FEE_BPS) ||
    PLATFORM_FEE_BPS < 0 ||
    AGENT_OWNER_FEE_BPS < 0 ||
    PLATFORM_FEE_BPS + AGENT_OWNER_FEE_BPS > MAX_TOTAL_FEE_BPS
  ) {
    throw new Error(
      `fee policy must be non-negative integers totalling <= MAX_TOTAL_FEE_BPS (${MAX_TOTAL_FEE_BPS}); ` +
        `got ${PLATFORM_FEE_BPS} + ${AGENT_OWNER_FEE_BPS}`,
    );
  }
  if (PLATFORM_FEE_BPS > 0 && !deployerPublic) {
    throw new Error("a non-zero platform fee needs a platform_recipient (Error::FeeNeedsRecipient)");
  }

  console.log("── Mimir Soroban deploy → Stellar Testnet ──");
  console.log(`  rpc        : ${SOROBAN_RPC_URL}`);
  console.log(`  passphrase : ${NETWORK_PASSPHRASE}`);
  console.log(`  deployer   : ${deployerPublic}`);
  console.log(`  oracle     : ${oraclePublic}`);
  console.log(`  usdc asset : ${USDC_ASSET}`);
  console.log(`  fee policy : platform ${PLATFORM_FEE_BPS} bps, agent-owner ${AGENT_OWNER_FEE_BPS} bps ` +
    `(cap ${MAX_TOTAL_FEE_BPS}), recipient ${deployerPublic}\n`);

  buildContracts();
  assertWasmPresent();
  {
    const mode = process.env.MIMIR_REQUIRE_ARTIFACT_PROVENANCE === "1" ? "release" : "develop";
    const provenance = verifyRepoArtifactProvenance({ mode, requireBuilt: true, repoRoot: REPO_ROOT });
    console.log(formatProvenanceReport(provenance));
    if (!provenance.ok) {
      throw new Error(
        "contract artifact provenance check failed — refuse to deploy mismatched or unverified Wasm " +
          "(pin digests with npm run verify:artifacts -- --write-pins, or set MIMIR_REQUIRE_ARTIFACT_PROVENANCE=1 for release gating)",
      );
    }
  }
  const usdcSac = resolveUsdcSac(deployerSecret);

  console.log("[3/5] deploying wasm…");
  const ids: Record<string, string> = {};
  for (const target of DEPLOYABLES) ids[target.key] = deployWasm(target, deployerSecret);

  console.log("[4/5] initializing…");
  invokeInitialize("mimir-market", ids.market, deployerSecret, [
    "--owner",
    deployerPublic,
    "--oracle",
    oraclePublic,
    "--usdc_token",
    usdcSac,
    "--platform_fee_bps",
    String(PLATFORM_FEE_BPS),
    "--agent_owner_fee_bps",
    String(AGENT_OWNER_FEE_BPS),
    "--platform_recipient",
    optionArg(deployerPublic),
  ]);
  invokeInitialize("mimir-squad", ids.squad, deployerSecret, [
    "--usdc",
    usdcSac,
    "--oracle",
    oraclePublic,
    "--fee_recipient",
    deployerPublic,
  ]);

  console.log("[5/5] writing .env.local…");
  writeEnvLocal(
    {
      [ENV_KEYS.usdcSac]: usdcSac,
      [ENV_KEYS.marketId]: ids.market,
      [ENV_KEYS.squadId]: ids.squad,
      [ENV_KEYS.network]: NETWORK,
      [ENV_KEYS.networkPassphrase]: NETWORK_PASSPHRASE,
      [ENV_KEYS.rpcUrl]: SOROBAN_RPC_URL,
      [ENV_KEYS.usdcIssuer]: USDC_ISSUER,
      [ENV_KEYS.platformFeeBps]: String(PLATFORM_FEE_BPS),
      [ENV_KEYS.agentOwnerFeeBps]: String(AGENT_OWNER_FEE_BPS),
    },
    { header: "# ── Mimir Soroban contracts (written by deploy/deploy.ts) ──" },
  );

  console.log("\n── Deployment ──");
  console.log(`  ${ENV_KEYS.usdcSac}=${usdcSac}`);
  console.log(`  ${ENV_KEYS.marketId}=${ids.market}`);
  console.log(`  ${ENV_KEYS.squadId}=${ids.squad}`);
  console.log(`\n  market : ${explorerContractUrl(ids.market)}`);
  console.log(`  squad  : ${explorerContractUrl(ids.squad)}`);
  console.log(`  usdc   : ${explorerContractUrl(usdcSac)}`);
  console.log(
    `\n  squad per-market fee_bps must stay <= ${SQUAD_MAX_FEE_BPS} (MAX_FEE_BPS in mimir-squad/src/types.rs)`,
  );
  console.log("\n✓ deploy complete — next: npm run stellar:bindings && npm run verify:deployment");
}

main().catch((error) => {
  console.error("Deploy failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
