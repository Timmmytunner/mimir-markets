import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  formatProvenanceReport,
  normalizeDigest,
  parseArtifactManifest,
  sha256Hex,
  verifyArtifactProvenance,
  verifyRepoArtifactProvenance,
  type ArtifactManifest,
} from "../../lib/ops/artifact-provenance";

const FIXTURE_DIR = join(process.cwd(), "tests", "fixtures", "artifact-provenance");
const MARKET_WASM = Buffer.from("mimir-market-fixture-wasm-v1");
const SQUAD_WASM = Buffer.from("mimir-squad-fixture-wasm-v1");
const MARKET_DIGEST = sha256Hex(MARKET_WASM);
const SQUAD_DIGEST = sha256Hex(SQUAD_WASM);

function baseManifest(overrides: Partial<ArtifactManifest> = {}): ArtifactManifest {
  return parseArtifactManifest({
    schemaVersion: 1,
    hashAlgorithm: "sha256",
    description: "fixture",
    artifacts: [
      {
        id: "mimir-market",
        crate: "mimir-market",
        sourceDir: "contracts-soroban/mimir-market",
        wasmPath: "out/mimir_market.wasm",
        buildTarget: "wasm32v1-none",
        profile: "release",
        sha256: MARKET_DIGEST,
      },
      {
        id: "mimir-squad",
        crate: "mimir-squad",
        sourceDir: "contracts-soroban/mimir-squad",
        wasmPath: "out/mimir_squad.wasm",
        buildTarget: "wasm32v1-none",
        profile: "release",
        sha256: SQUAD_DIGEST,
      },
    ],
    ...overrides,
  });
}

const existingSources = new Set([
  "contracts-soroban/mimir-market",
  "contracts-soroban/mimir-squad",
]);

const matchingFiles = {
  "out/mimir_market.wasm": MARKET_WASM,
  "out/mimir_squad.wasm": SQUAD_WASM,
};

test("normalizeDigest strips 0x and empty pins become null", () => {
  assert.equal(normalizeDigest(null), null);
  assert.equal(normalizeDigest(""), null);
  assert.equal(normalizeDigest(`0x${MARKET_DIGEST.toUpperCase()}`), MARKET_DIGEST);
});

test("positive: matching pins verify in develop and release", () => {
  const manifest = baseManifest();
  for (const mode of ["develop", "release"] as const) {
    const report = verifyArtifactProvenance(manifest, {
      mode,
      requireBuilt: true,
      fileContents: matchingFiles,
      existingPaths: existingSources,
    });
    assert.equal(report.ok, true, formatProvenanceReport(report));
    assert.equal(report.digests["mimir-market"], MARKET_DIGEST);
    assert.equal(report.digests["mimir-squad"], SQUAD_DIGEST);
    assert.equal(report.findings.filter((f) => f.severity === "error").length, 0);
  }
});

test("negative: digest mismatch fails closed", () => {
  const report = verifyArtifactProvenance(baseManifest(), {
    mode: "release",
    fileContents: {
      "out/mimir_market.wasm": Buffer.from("tampered-market"),
      "out/mimir_squad.wasm": SQUAD_WASM,
    },
    existingPaths: existingSources,
  });
  assert.equal(report.ok, false);
  assert.ok(report.findings.some((f) => f.code === "DIGEST_MISMATCH" && f.severity === "error"));
});

test("failure: missing artifact fails when requireBuilt", () => {
  const report = verifyArtifactProvenance(baseManifest(), {
    mode: "develop",
    requireBuilt: true,
    fileContents: { "out/mimir_market.wasm": MARKET_WASM },
    existingPaths: existingSources,
  });
  assert.equal(report.ok, false);
  assert.ok(report.findings.some((f) => f.code === "ARTIFACT_MISSING" && f.artifactId === "mimir-squad"));
});

test("failure: release mode refuses unpinned digests", () => {
  const manifest = baseManifest();
  manifest.artifacts[0].sha256 = null;
  const report = verifyArtifactProvenance(manifest, {
    mode: "release",
    fileContents: matchingFiles,
    existingPaths: existingSources,
  });
  assert.equal(report.ok, false);
  assert.ok(report.findings.some((f) => f.code === "DIGEST_UNPINNED" && f.severity === "error"));
});

test("develop mode warns on unpinned digests but stays ok when built", () => {
  const manifest = baseManifest();
  for (const artifact of manifest.artifacts) artifact.sha256 = null;
  const report = verifyArtifactProvenance(manifest, {
    mode: "develop",
    requireBuilt: true,
    fileContents: matchingFiles,
    existingPaths: existingSources,
  });
  assert.equal(report.ok, true);
  assert.ok(report.findings.every((f) => f.code === "DIGEST_UNPINNED" && f.severity === "warning"));
});

test("failure: invalid pin format is an error", () => {
  const manifest = baseManifest();
  manifest.artifacts[0].sha256 = "not-a-digest";
  const report = verifyArtifactProvenance(manifest, {
    mode: "develop",
    fileContents: matchingFiles,
    existingPaths: existingSources,
  });
  assert.equal(report.ok, false);
  assert.ok(report.findings.some((f) => f.code === "DIGEST_INVALID_PIN"));
});

test("failure: empty artifact list cannot silently pass", () => {
  const report = verifyArtifactProvenance(
    parseArtifactManifest({ schemaVersion: 1, hashAlgorithm: "sha256", artifacts: [] }),
    { mode: "release" },
  );
  assert.equal(report.ok, false);
  assert.ok(report.findings.some((f) => f.code === "EMPTY_ARTIFACTS"));
});

test("failure: duplicate artifact ids fail closed", () => {
  const raw = {
    schemaVersion: 1,
    hashAlgorithm: "sha256",
    artifacts: [
      {
        id: "mimir-market",
        crate: "mimir-market",
        sourceDir: "contracts-soroban/mimir-market",
        wasmPath: "out/a.wasm",
        buildTarget: "wasm32v1-none",
        profile: "release",
        sha256: MARKET_DIGEST,
      },
      {
        id: "mimir-market",
        crate: "mimir-market",
        sourceDir: "contracts-soroban/mimir-market",
        wasmPath: "out/b.wasm",
        buildTarget: "wasm32v1-none",
        profile: "release",
        sha256: MARKET_DIGEST,
      },
    ],
  };
  const report = verifyArtifactProvenance(parseArtifactManifest(raw), {
    mode: "develop",
    fileContents: { "out/a.wasm": MARKET_WASM, "out/b.wasm": MARKET_WASM },
    existingPaths: existingSources,
  });
  assert.equal(report.ok, false);
  assert.ok(report.findings.some((f) => f.code === "DUPLICATE_ARTIFACT_ID"));
});

test("parseArtifactManifest rejects wrong algorithm", () => {
  assert.throws(
    () => parseArtifactManifest({ schemaVersion: 1, hashAlgorithm: "sha1", artifacts: [] }),
    /hashAlgorithm/,
  );
});

test("regression: committed repo manifest parses and lists both contracts", () => {
  const report = verifyRepoArtifactProvenance({
    mode: "develop",
    requireBuilt: false,
    repoRoot: process.cwd(),
  });
  // Source crates exist in-repo; Wasm under target/ is gitignored so develop
  // without requireBuilt should not error on missing binaries.
  assert.equal(report.findings.some((f) => f.code === "MANIFEST_INVALID"), false);
  const manifest = parseArtifactManifest(
    JSON.parse(readFileSync(join(process.cwd(), "deploy", "contract-artifacts.manifest.json"), "utf8")),
  );
  assert.deepEqual(
    manifest.artifacts.map((a) => a.id).sort(),
    ["mimir-market", "mimir-squad"],
  );
  assert.equal(manifest.hashAlgorithm, "sha256");
});

test("fixture manifest file matches positive digest vectors", () => {
  const fixture = parseArtifactManifest(
    JSON.parse(readFileSync(join(FIXTURE_DIR, "pinned.manifest.json"), "utf8")),
  );
  const report = verifyArtifactProvenance(fixture, {
    mode: "release",
    fileContents: {
      "fixtures/mimir_market.wasm": MARKET_WASM,
      "fixtures/mimir_squad.wasm": SQUAD_WASM,
    },
    existingPaths: existingSources,
  });
  assert.equal(report.ok, true, formatProvenanceReport(report));
});
