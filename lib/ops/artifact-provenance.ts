/**
 * Contract artifact provenance — fail-closed Wasm digest verification.
 *
 * Funded features must not ship an unpinned or mismatched Soroban artifact.
 * This module checks a committed deployment manifest against local Wasm bytes:
 * SHA-256 digests, expected paths, and crate metadata. It never talks to RPC
 * and never reads secrets, so it is reproducible from a clean checkout.
 *
 * Modes:
 *  - `develop` — built files must match any pin that is present; unpinned
 *    digests warn but do not pass a release gate.
 *  - `release` — every artifact must be pinned and must match. Missing files,
 *    invalid pins, and mismatches are hard errors (fail-closed).
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export const DEFAULT_MANIFEST_RELATIVE = "deploy/contract-artifacts.manifest.json";
export const HASH_ALGORITHM = "sha256" as const;

export type VerifyMode = "develop" | "release";

export interface ArtifactEntry {
  id: string;
  crate: string;
  sourceDir: string;
  wasmPath: string;
  buildTarget: string;
  profile: string;
  /** Lowercase hex SHA-256 of the release Wasm, or null/empty when unpinned. */
  sha256: string | null;
}

export interface ArtifactManifest {
  schemaVersion: 1;
  hashAlgorithm: typeof HASH_ALGORITHM;
  description?: string;
  artifacts: ArtifactEntry[];
}

export interface ProvenanceFinding {
  code:
    | "MANIFEST_INVALID"
    | "EMPTY_ARTIFACTS"
    | "DUPLICATE_ARTIFACT_ID"
    | "ARTIFACT_MISSING"
    | "DIGEST_UNPINNED"
    | "DIGEST_INVALID_PIN"
    | "DIGEST_MISMATCH"
    | "SOURCE_DIR_MISSING";
  severity: "error" | "warning";
  artifactId?: string;
  message: string;
}

export interface ProvenanceReport {
  ok: boolean;
  mode: VerifyMode;
  findings: ProvenanceFinding[];
  /** Computed digests for artifacts whose files were readable. */
  digests: Record<string, string>;
}

export interface VerifyOptions {
  mode?: VerifyMode;
  /** Absolute or cwd-relative repo root. */
  repoRoot?: string;
  /** Require every wasmPath to exist (typical after `cargo build`). */
  requireBuilt?: boolean;
  /** Optional override of file contents keyed by wasmPath (tests). */
  fileContents?: Record<string, Uint8Array | Buffer>;
  /** Optional override: treat sourceDir existence checks via this set. */
  existingPaths?: Set<string>;
}

const HEX64 = /^[0-9a-f]{64}$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

/** Normalize a pin to lowercase hex or null when absent. */
export function normalizeDigest(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new Error("sha256 must be a string or null");
  const trimmed = value.trim().toLowerCase().replace(/^0x/, "");
  if (trimmed === "") return null;
  return trimmed;
}

export function sha256Hex(data: Uint8Array | Buffer | string): string {
  const buf = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * Parse and structurally validate a manifest. Throws on schema failures so
 * callers cannot "soft succeed" on garbage JSON.
 */
export function parseArtifactManifest(raw: unknown): ArtifactManifest {
  if (!isPlainObject(raw)) throw new Error("manifest must be a JSON object");
  if (raw.schemaVersion !== 1) throw new Error("schemaVersion must be 1");
  if (raw.hashAlgorithm !== HASH_ALGORITHM) {
    throw new Error(`hashAlgorithm must be "${HASH_ALGORITHM}"`);
  }
  if (!Array.isArray(raw.artifacts)) throw new Error("artifacts must be an array");

  const artifacts: ArtifactEntry[] = raw.artifacts.map((entry, index) => {
    if (!isPlainObject(entry)) throw new Error(`artifacts[${index}] must be an object`);
    const id = asNonEmptyString(entry.id, `artifacts[${index}].id`);
    const crate = asNonEmptyString(entry.crate, `artifacts[${index}].crate`);
    const sourceDir = asNonEmptyString(entry.sourceDir, `artifacts[${index}].sourceDir`);
    const wasmPath = asNonEmptyString(entry.wasmPath, `artifacts[${index}].wasmPath`);
    const buildTarget = asNonEmptyString(entry.buildTarget, `artifacts[${index}].buildTarget`);
    const profile = asNonEmptyString(entry.profile, `artifacts[${index}].profile`);
    let sha256: string | null;
    try {
      sha256 = normalizeDigest(entry.sha256);
    } catch {
      throw new Error(`artifacts[${index}].sha256 must be a string or null`);
    }
    return { id, crate, sourceDir, wasmPath, buildTarget, profile, sha256 };
  });

  return {
    schemaVersion: 1,
    hashAlgorithm: HASH_ALGORITHM,
    description: typeof raw.description === "string" ? raw.description : undefined,
    artifacts,
  };
}

export function loadArtifactManifest(filePath: string): ArtifactManifest {
  const text = readFileSync(filePath, "utf8");
  return parseArtifactManifest(JSON.parse(text) as unknown);
}

function push(findings: ProvenanceFinding[], finding: ProvenanceFinding): void {
  findings.push(finding);
}

/**
 * Verify artifact provenance against a manifest.
 *
 * Fail-closed: `ok` is true only when there are zero error-severity findings.
 * In release mode, unpinned digests are errors so money/deploy gates cannot
 * silently bypass an empty pin set.
 */
export function verifyArtifactProvenance(
  manifest: ArtifactManifest,
  options: VerifyOptions = {},
): ProvenanceReport {
  const mode: VerifyMode = options.mode ?? "develop";
  const repoRoot = options.repoRoot ?? process.cwd();
  const requireBuilt = options.requireBuilt ?? mode === "release";
  const findings: ProvenanceFinding[] = [];
  const digests: Record<string, string> = {};

  if (manifest.artifacts.length === 0) {
    push(findings, {
      code: "EMPTY_ARTIFACTS",
      severity: "error",
      message: "manifest lists no artifacts — refusing to treat an empty set as verified",
    });
    return { ok: false, mode, findings, digests };
  }

  const seen = new Set<string>();
  for (const artifact of manifest.artifacts) {
    if (seen.has(artifact.id)) {
      push(findings, {
        code: "DUPLICATE_ARTIFACT_ID",
        severity: "error",
        artifactId: artifact.id,
        message: `duplicate artifact id "${artifact.id}"`,
      });
      continue;
    }
    seen.add(artifact.id);

    const sourceAbs = path.resolve(repoRoot, artifact.sourceDir);
    const sourceExists = options.existingPaths
      ? options.existingPaths.has(artifact.sourceDir) || options.existingPaths.has(sourceAbs)
      : existsSync(sourceAbs);
    if (!sourceExists) {
      push(findings, {
        code: "SOURCE_DIR_MISSING",
        severity: "error",
        artifactId: artifact.id,
        message: `sourceDir missing: ${artifact.sourceDir}`,
      });
    }

    const pin = artifact.sha256;
    if (pin !== null && !HEX64.test(pin)) {
      push(findings, {
        code: "DIGEST_INVALID_PIN",
        severity: "error",
        artifactId: artifact.id,
        message: `pinned sha256 is not 64 lowercase hex chars`,
      });
      continue;
    }

    const wasmAbs = path.resolve(repoRoot, artifact.wasmPath);
    let bytes: Uint8Array | Buffer | undefined;
    if (options.fileContents && artifact.wasmPath in options.fileContents) {
      bytes = options.fileContents[artifact.wasmPath];
    } else if (existsSync(wasmAbs)) {
      bytes = readFileSync(wasmAbs);
    }

    if (!bytes) {
      if (requireBuilt || mode === "release") {
        push(findings, {
          code: "ARTIFACT_MISSING",
          severity: "error",
          artifactId: artifact.id,
          message:
            `missing Wasm at ${artifact.wasmPath} — build with ` +
            "`cargo build --manifest-path contracts-soroban/Cargo.toml --release --target wasm32v1-none` " +
            "or `npm run deploy:contract`",
        });
      }
      if (pin === null && mode === "release") {
        push(findings, {
          code: "DIGEST_UNPINNED",
          severity: "error",
          artifactId: artifact.id,
          message:
            `release mode refuses unpinned artifact "${artifact.id}" — ` +
            "run `npm run verify:artifacts -- --write-pins` after a clean build",
        });
      }
      continue;
    }

    const digest = sha256Hex(bytes);
    digests[artifact.id] = digest;

    if (pin === null) {
      push(findings, {
        code: "DIGEST_UNPINNED",
        severity: mode === "release" ? "error" : "warning",
        artifactId: artifact.id,
        message:
          mode === "release"
            ? `release mode refuses unpinned artifact "${artifact.id}" (computed ${digest.slice(0, 12)}…)`
            : `unpinned artifact "${artifact.id}" digest ${digest} — pin before funded release`,
      });
      continue;
    }

    if (digest !== pin) {
      push(findings, {
        code: "DIGEST_MISMATCH",
        severity: "error",
        artifactId: artifact.id,
        message:
          `Wasm digest mismatch for "${artifact.id}": ` +
          `computed ${digest}, manifest pin ${pin}. ` +
          "Refuse deploy/rollback to the pinned build, or update the pin only after intentional rebuild review.",
      });
    }
  }

  const ok = findings.every((f) => f.severity !== "error");
  return { ok, mode, findings, digests };
}

/** Format a report for CLI / deploy logs without leaking secrets. */
export function formatProvenanceReport(report: ProvenanceReport): string {
  const lines: string[] = [
    `artifact provenance (${report.mode}): ${report.ok ? "OK" : "FAILED"}`,
  ];
  for (const finding of report.findings) {
    const mark = finding.severity === "error" ? "✗" : "!";
    const who = finding.artifactId ? ` [${finding.artifactId}]` : "";
    lines.push(`  ${mark}${who} ${finding.code}: ${finding.message}`);
  }
  for (const [id, digest] of Object.entries(report.digests)) {
    lines.push(`  · ${id} sha256=${digest}`);
  }
  return lines.join("\n");
}

/**
 * Load the repo manifest and verify. Used by the CLI and by deploy.
 */
export function verifyRepoArtifactProvenance(
  options: VerifyOptions & { manifestPath?: string } = {},
): ProvenanceReport {
  const repoRoot = options.repoRoot ?? process.cwd();
  const manifestPath = path.resolve(repoRoot, options.manifestPath ?? DEFAULT_MANIFEST_RELATIVE);
  if (!existsSync(manifestPath)) {
    return {
      ok: false,
      mode: options.mode ?? "develop",
      digests: {},
      findings: [
        {
          code: "MANIFEST_INVALID",
          severity: "error",
          message: `manifest not found at ${path.relative(repoRoot, manifestPath) || DEFAULT_MANIFEST_RELATIVE}`,
        },
      ],
    };
  }
  let manifest: ArtifactManifest;
  try {
    manifest = loadArtifactManifest(manifestPath);
  } catch (error) {
    return {
      ok: false,
      mode: options.mode ?? "develop",
      digests: {},
      findings: [
        {
          code: "MANIFEST_INVALID",
          severity: "error",
          message: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }
  return verifyArtifactProvenance(manifest, { ...options, repoRoot });
}
