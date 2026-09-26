import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  checkToolchains,
  ciMatrix,
  compareVersions,
  inheritsRustVersion,
  normalizeVersion,
  tomlString,
  toolchainTargets,
  type ToolchainSources,
} from "../../scripts/lib/contract-toolchains";

// ── Fixtures ──────────────────────────────────────────────────────────────────
// Versions here are illustrative and independent of the repo's real pins, so a
// toolchain bump never has to touch this file. The last test covers the real one.

const TOOLCHAIN = `[toolchain]
channel = "1.94.0"
targets = ["wasm32v1-none"]
profile = "minimal"
`;

const WORKSPACE = `[workspace]
resolver = "2"
members = ["mimir-market", "mimir-squad"]

[workspace.package]
rust-version = "1.91"   # soroban-sdk's own MSRV

[workspace.dependencies]
soroban-sdk = "25.3.2"
`;

const MEMBER = `[package]
name = "mimir-market"
version = "0.1.0"
edition = "2021"
rust-version.workspace = true
`;

const CI = `jobs:
  contracts:
    strategy:
      fail-fast: false
      matrix:
        include:
          - name: msrv
            toolchain: "1.91.0"
          - name: release
            toolchain: "1.94.0"
          - name: stable
            toolchain: stable
`;

function sources(overrides: Partial<ToolchainSources> = {}): ToolchainSources {
  return {
    toolchainToml: TOOLCHAIN,
    workspaceToml: WORKSPACE,
    memberTomls: { "mimir-market": MEMBER, "mimir-squad": MEMBER.replace("mimir-market", "mimir-squad") },
    ciYaml: CI,
    ...overrides,
  };
}

function problems(overrides: Partial<ToolchainSources> = {}): string[] {
  return checkToolchains(sources(overrides)).problems;
}

// ── Positive ──────────────────────────────────────────────────────────────────

test("a consistent set of files passes and reports what it read", () => {
  const report = checkToolchains(sources());
  assert.deepEqual(report.problems, []);
  assert.equal(report.msrv, "1.91");
  assert.equal(report.release, "1.94.0");
  assert.deepEqual(report.matrix, { msrv: "1.91.0", release: "1.94.0", stable: "stable" });
});

test("an MSRV written as X.Y matches a matrix entry written as X.Y.0", () => {
  assert.equal(normalizeVersion("1.91"), "1.91.0");
  assert.equal(normalizeVersion("1.91.2"), "1.91.2");
  assert.deepEqual(problems(), []);
});

test("release may equal the MSRV", () => {
  const same = TOOLCHAIN.replace("1.94.0", "1.91.0");
  assert.deepEqual(problems({ toolchainToml: same, ciYaml: CI.replace('"1.94.0"', '"1.91.0"') }), []);
});

test("CRLF files parse like LF files", () => {
  const crlf = (text: string) => text.replace(/\n/g, "\r\n");
  assert.deepEqual(
    problems({ toolchainToml: crlf(TOOLCHAIN), workspaceToml: crlf(WORKSPACE), ciYaml: crlf(CI),
      memberTomls: { "mimir-market": crlf(MEMBER) } }),
    [],
  );
});

// ── Negative: each rule, with a message that says which file to fix ───────────

test("a floating release channel is refused, because the wasm hash would drift", () => {
  for (const channel of ["stable", "nightly", "beta", "1.94"]) {
    const found = problems({ toolchainToml: TOOLCHAIN.replace('"1.94.0"', `"${channel}"`),
      ciYaml: CI.replace('"1.94.0"', `"${channel}"`) });
    assert.ok(found.some((p) => p.startsWith("rust-toolchain.toml:") && p.includes("floats")), channel);
  }
});

test("a missing toolchain file is reported, not treated as unpinned-and-fine", () => {
  assert.ok(problems({ toolchainToml: null }).some((p) => /rust-toolchain\.toml: missing/.test(p)));
});

test("the toolchain file must provide the wasm target", () => {
  const found = problems({ toolchainToml: TOOLCHAIN.replace('"wasm32v1-none"', '"wasm32-unknown-unknown"') });
  assert.ok(found.some((p) => p.includes('add "wasm32v1-none" to targets')));
});

test("an undeclared MSRV is reported", () => {
  const found = problems({ workspaceToml: WORKSPACE.replace(/rust-version = .*\n/, "") });
  assert.ok(found.some((p) => p.includes("add `rust-version")));
});

test("a member that does not inherit the MSRV is named", () => {
  const found = problems({ memberTomls: { "mimir-squad": MEMBER.replace(/rust-version.*\n/, "") } });
  assert.deepEqual(found, ["contracts-soroban/mimir-squad/Cargo.toml: add `rust-version.workspace = true` under [package]"]);
});

test("the msrv job must test the declared MSRV", () => {
  const found = problems({ ciYaml: CI.replace('"1.91.0"', '"1.92.0"') });
  assert.deepEqual(found, [
    ".github/workflows/ci.yml: msrv job uses 1.92.0 but Cargo.toml declares rust-version 1.91; change them together",
  ]);
});

test("the release job must build with the pinned toolchain", () => {
  const found = problems({ ciYaml: CI.replace('"1.94.0"', '"1.95.0"') });
  assert.deepEqual(found, [
    ".github/workflows/ci.yml: release job uses 1.95.0 but rust-toolchain.toml pins 1.94.0; change them together",
  ]);
});

test("every matrix entry is required", () => {
  for (const name of ["msrv", "release", "stable"]) {
    const stripped = CI.replace(new RegExp(`- name: ${name}\\n\\s+toolchain: .*\\n`), "");
    assert.ok(problems({ ciYaml: stripped }).some((p) => p.includes(`no "${name}" entry`)), name);
  }
});

test("the stable entry must track stable", () => {
  const found = problems({ ciYaml: CI.replace("toolchain: stable", 'toolchain: "1.96.0"') });
  assert.ok(found.some((p) => p.includes('"stable" entry must use toolchain stable')));
});

test("a release toolchain older than the MSRV is refused", () => {
  const found = problems({ toolchainToml: TOOLCHAIN.replace("1.94.0", "1.90.0"),
    ciYaml: CI.replace('"1.94.0"', '"1.90.0"') });
  assert.ok(found.some((p) => p.includes("release 1.90.0 is older than the declared MSRV 1.91")));
});

// ── Parsing edges ─────────────────────────────────────────────────────────────

test("version comparison is numeric, not lexical", () => {
  assert.ok(compareVersions("1.100.0", "1.91.0") > 0);
  assert.ok(compareVersions("1.9.0", "1.91") < 0);
  assert.equal(compareVersions("1.91", "1.91.0"), 0);
});

test("toml lookups are scoped to their section and ignore comments", () => {
  const toml = `[package]\nrust-version = "9.9"\n[workspace.package]\n# rust-version = "0.1"\nrust-version = "1.91"\n`;
  assert.equal(tomlString(toml, "workspace.package", "rust-version"), "1.91");
  assert.equal(tomlString(toml, "toolchain", "channel"), null);
  assert.equal(inheritsRustVersion("[dependencies]\nrust-version.workspace = true\n"), false);
  assert.deepEqual(toolchainTargets('[toolchain]\ntargets = ["a", "wasm32v1-none"]\n'), ["a", "wasm32v1-none"]);
});

test("unrelated matrix entries are ignored", () => {
  assert.deepEqual(ciMatrix(`${CI}          - name: beta\n            toolchain: beta\n`),
    { msrv: "1.91.0", release: "1.94.0", stable: "stable" });
});

// ── Regression: the repo's own files ──────────────────────────────────────────

test("the repository's toolchain files are consistent", () => {
  const root = process.cwd();
  const read = (file: string) => readFileSync(path.join(root, file), "utf8");
  const toolchainPath = path.join(root, "rust-toolchain.toml");
  const report = checkToolchains({
    toolchainToml: existsSync(toolchainPath) ? readFileSync(toolchainPath, "utf8") : null,
    workspaceToml: read("contracts-soroban/Cargo.toml"),
    memberTomls: {
      "mimir-market": read("contracts-soroban/mimir-market/Cargo.toml"),
      "mimir-squad": read("contracts-soroban/mimir-squad/Cargo.toml"),
    },
    ciYaml: read(".github/workflows/ci.yml"),
  });
  assert.deepEqual(report.problems, []);
});
