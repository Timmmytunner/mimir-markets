/**
 * Verify (or pin) Soroban contract artifact provenance.
 *
 *   npm run verify:artifacts
 *   npm run verify:artifacts -- --mode=release --require-built
 *   npm run verify:artifacts -- --write-pins
 *
 * No RPC, no production secrets. Digests and paths only.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_MANIFEST_RELATIVE,
  formatProvenanceReport,
  loadArtifactManifest,
  sha256Hex,
  verifyRepoArtifactProvenance,
  type VerifyMode,
} from "../lib/ops/artifact-provenance";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST_PATH = path.join(REPO_ROOT, DEFAULT_MANIFEST_RELATIVE);

function parseArgs(argv: string[]): {
  mode: VerifyMode;
  requireBuilt: boolean;
  writePins: boolean;
} {
  const args = new Set(argv);
  const mode: VerifyMode = args.has("--mode=release") || args.has("--release") ? "release" : "develop";
  return {
    mode,
    requireBuilt: args.has("--require-built") || mode === "release",
    writePins: args.has("--write-pins"),
  };
}

function writePins(): void {
  if (!existsSync(MANIFEST_PATH)) {
    throw new Error(`manifest missing: ${DEFAULT_MANIFEST_RELATIVE}`);
  }
  const manifest = loadArtifactManifest(MANIFEST_PATH);
  let updated = 0;
  for (const artifact of manifest.artifacts) {
    const wasmAbs = path.join(REPO_ROOT, artifact.wasmPath);
    if (!existsSync(wasmAbs)) {
      throw new Error(`cannot pin "${artifact.id}": missing ${artifact.wasmPath}`);
    }
    artifact.sha256 = sha256Hex(readFileSync(wasmAbs));
    updated += 1;
  }
  writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(`wrote ${updated} sha256 pin(s) → ${DEFAULT_MANIFEST_RELATIVE}`);
  for (const artifact of manifest.artifacts) {
    console.log(`  · ${artifact.id} ${artifact.sha256}`);
  }
}

function main(): void {
  const { mode, requireBuilt, writePins: shouldWrite } = parseArgs(process.argv.slice(2));

  if (shouldWrite) {
    writePins();
    const report = verifyRepoArtifactProvenance({
      repoRoot: REPO_ROOT,
      mode: "release",
      requireBuilt: true,
    });
    console.log(formatProvenanceReport(report));
    if (!report.ok) process.exit(1);
    return;
  }

  const envRelease = process.env.MIMIR_REQUIRE_ARTIFACT_PROVENANCE === "1";
  const effectiveMode: VerifyMode = envRelease ? "release" : mode;
  const report = verifyRepoArtifactProvenance({
    repoRoot: REPO_ROOT,
    mode: effectiveMode,
    requireBuilt: requireBuilt || effectiveMode === "release",
  });
  console.log(formatProvenanceReport(report));
  if (!report.ok) process.exit(1);
}

main();
