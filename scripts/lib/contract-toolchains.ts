/**
 * Consistency rules for the Soroban contract toolchain matrix.
 *
 * Three files describe the toolchains the contracts are built with, and they only
 * mean something while they agree:
 *
 *  - `rust-toolchain.toml` pins the RELEASE toolchain. soroban-sdk records the
 *    compiler version in the wasm's contract metadata, so the deployed wasm hash —
 *    which `verify:deployment` compares against a local build — is only
 *    reproducible when every build uses the same rustc. A floating channel makes
 *    that comparison fail the day a new stable ships.
 *  - `contracts-soroban/Cargo.toml` declares the MSRV as `rust-version`, so an
 *    older compiler fails with a clear "requires rustc X" instead of a deep error.
 *  - `.github/workflows/ci.yml` runs the contract matrix: msrv, release, stable.
 *
 * Pure functions over file contents, so the node tests can feed fixtures and the
 * CLI (`scripts/check-contract-toolchains.ts`) can feed the real files.
 */

export const WASM_TARGET = "wasm32v1-none";
export const REQUIRED_MATRIX_ENTRIES = ["msrv", "release", "stable"] as const;
export type MatrixEntry = (typeof REQUIRED_MATRIX_ENTRIES)[number];

export interface ToolchainSources {
  /** Contents of the repo-root `rust-toolchain.toml`, or null when absent. */
  toolchainToml: string | null;
  /** Contents of `contracts-soroban/Cargo.toml`. */
  workspaceToml: string;
  /** Contents of each member crate's `Cargo.toml`, keyed by crate directory. */
  memberTomls: Record<string, string>;
  /** Contents of `.github/workflows/ci.yml`. */
  ciYaml: string;
}

export interface ToolchainReport {
  msrv: string | null;
  release: string | null;
  matrix: Partial<Record<MatrixEntry, string>>;
  /** Empty when consistent. Each entry says what is wrong and which file to fix. */
  problems: string[];
}

const EXACT_VERSION = /^\d+\.\d+\.\d+$/;
const MSRV_VERSION = /^\d+\.\d+(\.\d+)?$/;

/** `1.91` and `1.91.0` name the same minimum; compare them as equal. */
export function normalizeVersion(version: string): string {
  return version.split(".").length === 2 ? `${version}.0` : version;
}

/** Negative, zero or positive, like a sort comparator. Only for X.Y[.Z]. */
export function compareVersions(a: string, b: string): number {
  const pa = normalizeVersion(a).split(".").map(Number);
  const pb = normalizeVersion(b).split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

/** Value of `key = "…"` inside `[section]` of a TOML file. Enough for these files. */
export function tomlString(toml: string, section: string, key: string): string | null {
  let current = "";
  for (const raw of toml.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const header = line.match(/^\[([^\]]+)\]$/);
    if (header) {
      current = header[1].trim();
      continue;
    }
    if (current !== section) continue;
    const match = line.match(new RegExp(`^${key.replace(".", "\\.")}\\s*=\\s*"([^"]*)"`));
    if (match) return match[1];
  }
  return null;
}

/** True when `[package]` has `rust-version.workspace = true`. */
export function inheritsRustVersion(memberToml: string): boolean {
  let current = "";
  for (const raw of memberToml.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const header = line.match(/^\[([^\]]+)\]$/);
    if (header) {
      current = header[1].trim();
      continue;
    }
    if (current === "package" && /^rust-version\.workspace\s*=\s*true$/.test(line)) return true;
  }
  return false;
}

/** Array entries of `targets = [...]` in `[toolchain]`. */
export function toolchainTargets(toolchainToml: string): string[] {
  const match = toolchainToml.match(/^\s*targets\s*=\s*\[([^\]]*)\]/m);
  if (!match) return [];
  return [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

/**
 * The contract matrix from ci.yml. Expects the shape the workflow uses:
 *
 *     - name: msrv
 *       toolchain: "1.91.0"
 *
 * Parsed by pattern rather than with a YAML library, which would be a new
 * dependency for a dozen lines of config.
 */
export function ciMatrix(ciYaml: string): Partial<Record<MatrixEntry, string>> {
  const matrix: Partial<Record<MatrixEntry, string>> = {};
  const entry = /-\s*name:\s*"?([a-z]+)"?\s*\r?\n\s*toolchain:\s*"?([^"\s#]+)"?/g;
  for (const match of ciYaml.matchAll(entry)) {
    const name = match[1] as MatrixEntry;
    if ((REQUIRED_MATRIX_ENTRIES as readonly string[]).includes(name)) matrix[name] = match[2];
  }
  return matrix;
}

export function checkToolchains(sources: ToolchainSources): ToolchainReport {
  const problems: string[] = [];

  // ── MSRV ────────────────────────────────────────────────────────────────────
  const msrv = tomlString(sources.workspaceToml, "workspace.package", "rust-version");
  if (!msrv) {
    problems.push(
      'contracts-soroban/Cargo.toml: add `rust-version = "<msrv>"` under [workspace.package]',
    );
  } else if (!MSRV_VERSION.test(msrv)) {
    problems.push(`contracts-soroban/Cargo.toml: rust-version "${msrv}" is not a version like 1.91 or 1.91.0`);
  }
  for (const [member, toml] of Object.entries(sources.memberTomls)) {
    if (!inheritsRustVersion(toml)) {
      problems.push(`contracts-soroban/${member}/Cargo.toml: add \`rust-version.workspace = true\` under [package]`);
    }
  }

  // ── Release toolchain ───────────────────────────────────────────────────────
  let release: string | null = null;
  if (sources.toolchainToml === null) {
    problems.push("rust-toolchain.toml: missing at the repo root; pin the release toolchain there");
  } else {
    release = tomlString(sources.toolchainToml, "toolchain", "channel");
    if (!release) {
      problems.push('rust-toolchain.toml: set `channel = "X.Y.Z"` under [toolchain]');
    } else if (!EXACT_VERSION.test(release)) {
      problems.push(
        `rust-toolchain.toml: channel "${release}" floats; pin an exact X.Y.Z so the deployed wasm hash is reproducible`,
      );
    }
    if (!toolchainTargets(sources.toolchainToml).includes(WASM_TARGET)) {
      problems.push(`rust-toolchain.toml: add "${WASM_TARGET}" to targets`);
    }
  }

  // ── CI matrix ───────────────────────────────────────────────────────────────
  const matrix = ciMatrix(sources.ciYaml);
  for (const name of REQUIRED_MATRIX_ENTRIES) {
    if (!matrix[name]) problems.push(`.github/workflows/ci.yml: contract matrix has no "${name}" entry`);
  }
  if (matrix.stable && matrix.stable !== "stable") {
    problems.push(`.github/workflows/ci.yml: the "stable" entry must use toolchain stable, not "${matrix.stable}"`);
  }
  if (matrix.msrv && msrv && MSRV_VERSION.test(msrv) &&
      normalizeVersion(matrix.msrv) !== normalizeVersion(msrv)) {
    problems.push(
      `.github/workflows/ci.yml: msrv job uses ${matrix.msrv} but Cargo.toml declares rust-version ${msrv}; change them together`,
    );
  }
  if (matrix.release && release && matrix.release !== release) {
    problems.push(
      `.github/workflows/ci.yml: release job uses ${matrix.release} but rust-toolchain.toml pins ${release}; change them together`,
    );
  }

  // ── Ordering ────────────────────────────────────────────────────────────────
  if (msrv && release && MSRV_VERSION.test(msrv) && EXACT_VERSION.test(release) &&
      compareVersions(release, msrv) < 0) {
    problems.push(`rust-toolchain.toml: release ${release} is older than the declared MSRV ${msrv}`);
  }

  return { msrv, release, matrix, problems };
}
