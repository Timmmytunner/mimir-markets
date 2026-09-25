import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildCycloneDxFromLockfile,
  loadLockfile,
  main,
  parseArgs,
  stampMetadata,
  writeSbom,
} from "../../scripts/generate-release-sbom.mjs";

const FIXTURES = join(process.cwd(), "tests", "fixtures", "release-sbom");

test("positive: builds CycloneDX 1.5 SBOM from a valid lockfile fixture", () => {
  const lock = loadLockfile(join(FIXTURES, "valid-package-lock.json"));
  const bom = stampMetadata(buildCycloneDxFromLockfile(lock), {
    timestamp: "2026-01-01T00:00:00.000Z",
  });

  assert.equal(bom.bomFormat, "CycloneDX");
  assert.equal(bom.specVersion, "1.5");
  assert.equal(bom.metadata.component.name, "fixture-app");
  assert.equal(bom.metadata.component.version, "1.2.3");
  assert.equal(bom.metadata.timestamp, "2026-01-01T00:00:00.000Z");
  assert.ok(bom.components.length >= 2, "expected direct + transitive components");

  const names = bom.components.map((c) => c.name).sort();
  assert.deepEqual(names, ["left-pad", "ms"]);
  for (const c of bom.components) {
    assert.equal(c.type, "library");
    assert.ok(c.purl.startsWith("pkg:npm/"));
    assert.ok(c.version);
    assert.ok(c["bom-ref"]);
  }
  // Deterministic ordering by purl
  const purls = bom.components.map((c) => c.purl);
  assert.deepEqual(purls, [...purls].sort());
});

test("negative: rejects unsupported lockfileVersion", () => {
  assert.throws(
    () => buildCycloneDxFromLockfile({ lockfileVersion: 1, packages: { "": {} } }),
    /unsupported lockfileVersion/,
  );
});

test("failure: refuses empty component set (fail-closed)", () => {
  const lock = loadLockfile(join(FIXTURES, "empty-packages-lock.json"));
  assert.throws(
    () => buildCycloneDxFromLockfile(lock),
    /zero package components|empty SBOM/,
  );
});

test("failure: malformed lockfile JSON is actionable", () => {
  assert.throws(
    () => loadLockfile(join(FIXTURES, "malformed-lock.json")),
    /not valid JSON/,
  );
});

test("failure: missing lockfile path is actionable", () => {
  assert.throws(
    () => loadLockfile(join(FIXTURES, "does-not-exist.json")),
    /cannot read lockfile/,
  );
});

test("regression: scoped package names encode into valid purls", () => {
  const bom = buildCycloneDxFromLockfile({
    lockfileVersion: 3,
    name: "app",
    version: "0.0.1",
    packages: {
      "": { name: "app", version: "0.0.1" },
      "node_modules/@scope/pkg": {
        version: "9.9.9",
        resolved: "https://registry.npmjs.org/@scope/pkg/-/pkg-9.9.9.tgz",
        integrity: "sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==",
      },
    },
  });
  const c = bom.components[0];
  assert.equal(c.name, "@scope/pkg");
  assert.match(c.purl, /^pkg:npm\/%40scope\/pkg@9\.9\.9$/);
  assert.ok(c.hashes?.[0]?.alg === "SHA-512");
});

test("cli: writes SBOM to --out and exits 0", () => {
  const dir = mkdtempSync(join(tmpdir(), "mimir-sbom-"));
  try {
    const out = join(dir, "out.cdx.json");
    const code = main([
      "--lock",
      join(FIXTURES, "valid-package-lock.json"),
      "--out",
      out,
      "--name",
      "fixture-app",
      "--version",
      "1.2.3",
    ]);
    assert.equal(code, 0);
    const written = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(written.bomFormat, "CycloneDX");
    assert.ok(written.components.length >= 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parseArgs: rejects unknown flags", () => {
  assert.throws(() => parseArgs(["--nope"]), /Unknown argument/);
});
