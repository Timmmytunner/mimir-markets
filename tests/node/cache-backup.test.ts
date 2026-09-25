import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  CACHE_BACKUP_HASH_ALGORITHM,
  CACHE_BACKUP_KIND,
  CACHE_BACKUP_SCHEMA_VERSION,
  READ_INDEX_TABLES,
  backupFingerprint,
  canonicalValue,
  computeBackupChecksum,
  formatCacheBackupReport,
  makeBackup,
  parseBackup,
  serializeBackup,
  verifyCacheBackup,
  type BackupTables,
  type ReadIndexBackup,
} from "../../lib/ops/cache-backup";

const FIXTURE_DIR = join(process.cwd(), "tests", "fixtures", "cache-backup");

function fixtureJson(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name), "utf8");
}

function fixtureBackup(name = "valid.json"): ReadIndexBackup {
  return parseBackup(fixtureJson(name)) as ReadIndexBackup;
}

/** Deep-shuffle row arrays so the checksum has to prove order independence. */
function shuffleTables(tables: BackupTables): BackupTables {
  const copy = structuredClone(tables) as BackupTables;
  for (const name of READ_INDEX_TABLES) {
    const rows = copy[name];
    for (let i = rows.length - 1; i > 0; i--) {
      const j = Math.floor((i * 7 + 3) % (i + 1));
      [rows[i], rows[j]] = [rows[j], rows[i]];
    }
  }
  return copy;
}

// ── positive ────────────────────────────────────────────────────────────────

test("positive: a self-built backup verifies and fingerprints to its checksum", () => {
  const backup = fixtureBackup();
  const report = verifyCacheBackup(serializeBackup(backup));
  assert.equal(report.ok, true, formatCacheBackupReport(report));
  assert.ok(report.backup);
  assert.equal(backupFingerprint(report.backup), report.backup.checksum);
  assert.equal(report.findings.length, 0);
});

test("positive: committed valid.json fixture verifies on a clean checkout", () => {
  const report = verifyCacheBackup(fixtureJson("valid.json"));
  assert.equal(report.ok, true, formatCacheBackupReport(report));
  assert.ok(report.backup);
  assert.deepEqual(
    Object.keys(report.backup.tables).sort(),
    [...READ_INDEX_TABLES].sort(),
  );
});

test("positive: createdAt/source metadata never affects the checksum", () => {
  const tables = fixtureBackup().tables;
  const early = makeBackup(tables, { createdAt: 1 });
  const late = makeBackup(tables, { createdAt: Date.now(), source: { network: "x" } });
  assert.equal(early.checksum, late.checksum);
});

test("positive: row order does not change the checksum (deterministic bytes)", () => {
  const tables = fixtureBackup().tables;
  const original = computeBackupChecksum(tables);
  const shuffled = computeBackupChecksum(shuffleTables(tables));
  assert.equal(shuffled, original);
});

test("positive: serialize → parse → serialize is byte-identical", () => {
  const backup = fixtureBackup();
  const text = serializeBackup(backup);
  const reparsed = parseBackup(text);
  assert.equal(serializeBackup(reparsed), text);
  assert.equal(reparsed.checksum, backup.checksum);
});

test("positive: a restore can prove equality with the archive via fingerprint", () => {
  const backup = fixtureBackup();
  // A restore re-dumps tables and recomputes; equal fingerprints mean the cache
  // matches the archive. Force identical payload → identical fingerprint.
  const reDumped = makeBackup(backup.tables, { createdAt: 999 });
  assert.equal(backupFingerprint(reDumped), backup.checksum);
});

// ── negative ────────────────────────────────────────────────────────────────

test("negative: a tampered row fails the checksum", () => {
  const backup = fixtureBackup();
  backup.tables.challengers[0] = {
    ...backup.tables.challengers[0],
    stake: 400, // attacker bumps a stake
  };
  const report = verifyCacheBackup(backend(backup));
  assert.equal(report.ok, false);
  assert.ok(report.findings.some((f) => f.code === "BACKUP_CHECKSUM_MISMATCH"));
});

test("negative: committed checksum-mismatch fixture fails closed", () => {
  const report = verifyCacheBackup(fixtureJson("checksum-mismatch.json"));
  assert.equal(report.ok, false);
  assert.ok(report.findings.some((f) => f.code === "BACKUP_CHECKSUM_MISMATCH"));
});

test("negative: a private claim leaking content is refused", () => {
  const report = verifyCacheBackup(fixtureJson("private-content-visible.json"));
  assert.equal(report.ok, false);
  assert.ok(
    report.findings.some(
      (f) => f.code === "BACKUP_PRIVATE_CONTENT_LEAK" && f.claimId === 202,
    ),
  );
});

// ── failure ─────────────────────────────────────────────────────────────────

test("failure: malformed JSON is an actionable failure", () => {
  const report = verifyCacheBackup(fixtureJson("malformed.json"));
  assert.equal(report.ok, false);
  assert.deepEqual(report.findings.map((f) => f.code), ["BACKUP_INVALID"]);
  assert.match(report.findings[0].message, /not valid JSON/);
});

test("failure: unsupported schema version is refused, not guessed", () => {
  const report = verifyCacheBackup(fixtureJson("unsupported-schema.json"));
  assert.equal(report.ok, false);
  assert.deepEqual(report.findings.map((f) => f.code), ["BACKUP_SCHEMA_UNSUPPORTED"]);
});

test("failure: wrong kind is refused", () => {
  const raw = fixtureBackup();
  const text = JSON.stringify({ ...raw, kind: "mimir-other-export" });
  const report = verifyCacheBackup(text);
  assert.equal(report.ok, false);
  assert.deepEqual(report.findings.map((f) => f.code), ["BACKUP_KIND_MISMATCH"]);
});

test("failure: a missing required table is a structural failure", () => {
  const report = verifyCacheBackup(fixtureJson("missing-table.json"));
  assert.equal(report.ok, false);
  assert.ok(report.findings.some((f) => f.code === "BACKUP_INVALID"));
  assert.match(report.findings[0].message, /missing required table "challengers"/);
});

test("failure: an unknown table is a structural failure", () => {
  const report = verifyCacheBackup(fixtureJson("unknown-table.json"));
  assert.equal(report.ok, false);
  assert.ok(report.findings.some((f) => f.code === "BACKUP_INVALID"));
  assert.match(report.findings[0].message, /unknown backup table "payments_v2"/);
});

test("failure: an empty snapshot cannot be treated as a verified backup", () => {
  const report = verifyCacheBackup(fixtureJson("empty-payload.json"));
  assert.equal(report.ok, false);
  // Self-consistent checksum → the ONLY finding must be emptiness itself, so
  // a checksum mismatch can never mask (or be mistaken for) the empty gate.
  assert.deepEqual(report.findings.map((f) => f.code), ["BACKUP_EMPTY"]);
});

test("failure: non-object rows are structural failures", () => {
  const backup = fixtureBackup();
  (backup.tables.sync_meta as unknown) = ["not-an-object"];
  const report = verifyCacheBackup(backend(backup));
  assert.equal(report.ok, false);
  assert.ok(report.findings.some((f) => f.code === "BACKUP_INVALID"));
});

test("failure: parseBackup throws on garbage instead of soft-succeeding", () => {
  assert.throws(() => parseBackup(fixtureJson("malformed.json")), /JSON/);
  const report = verifyCacheBackup(42);
  assert.equal(report.ok, false);
  assert.ok(report.findings.some((f) => f.code === "BACKUP_INVALID"));
  assert.match(report.findings[0].message, /must be a JSON object/);
});

// ── canonicalization ────────────────────────────────────────────────────────

test("canonicalValue: bigints and non-finite numbers are handled safely", () => {
  assert.equal(canonicalValue(123n), "123");
  assert.deepEqual(canonicalValue({ b: 1n, a: "x" }), { a: "x", b: "1" });
  assert.throws(() => canonicalValue(Number.NaN), /non-finite/);
  assert.throws(() => canonicalValue(Infinity), /non-finite/);
});

// ── regression ──────────────────────────────────────────────────────────────

test("regression: backup format constants and table list are pinned", () => {
  assert.equal(CACHE_BACKUP_SCHEMA_VERSION, 1);
  assert.equal(CACHE_BACKUP_KIND, "mimir-read-index-backup");
  assert.equal(CACHE_BACKUP_HASH_ALGORITHM, "sha256");
  assert.deepEqual(READ_INDEX_TABLES, [
    "claims",
    "challengers",
    "sync_meta",
    "market_settlements",
    "fee_accruals",
    "fee_claims",
    "fee_policies",
    "agent_revenue_attribution",
  ]);
});

test("regression: every committed fixture is loadable and typed correctly", () => {
  // Structurally valid fixtures parse and expose all 8 tables.
  const validNames = [
    "valid.json",
    "checksum-mismatch.json",
    "private-content-visible.json",
    "empty-payload.json",
  ];
  for (const name of validNames) {
    const backup = fixtureBackup(name);
    for (const tableName of READ_INDEX_TABLES) {
      assert.ok(Array.isArray(backup.tables[tableName]), `${name}: ${tableName} array`);
    }
  }
  // Negative structural fixtures must never parse.
  assert.throws(() => fixtureBackup("missing-table.json"), /missing required table/);
  assert.throws(() => fixtureBackup("unknown-table.json"), /unknown backup table/);
  assert.throws(() => fixtureBackup("unsupported-schema.json"), /schemaVersion must be 1/);
  assert.throws(() => fixtureBackup("malformed.json"), /JSON/);
});

// ── integration (real Postgres; skipped without DATABASE_URL) ───────────────

const HAS_DB = Boolean(process.env.DATABASE_URL?.trim());
const describeDb = HAS_DB ? test : test.skip;

function backend(backup: ReadIndexBackup): string {
  return serializeBackup(backup);
}

describeDb("restore round-trips the DB without changing its fingerprint", async () => {
  const { backUpReadIndex, restoreReadIndexFromBackup } = await import(
    "../../lib/server/read-index-backup"
  );
  const { backup } = await backUpReadIndex();
  const text = serializeBackup(backup);

  const result = await restoreReadIndexFromBackup(text);
  assert.equal(result.applied, true);
  assert.equal(result.verify.ok, true, formatCacheBackupReport(result.verify));
});

describeDb("dry-run reports without writing and stays consistent", async () => {
  const { backUpReadIndex, restoreReadIndexFromBackup } = await import(
    "../../lib/server/read-index-backup"
  );
  const { backup } = await backUpReadIndex();
  const result = await restoreReadIndexFromBackup(serializeBackup(backup), {
    dryRun: true,
  });
  assert.equal(result.applied, false);
  assert.equal(result.verify.ok, true);

  // A real restore after the dry-run must still verify.
  const applied = await restoreReadIndexFromBackup(serializeBackup(backup));
  assert.equal(applied.verify.ok, true, formatCacheBackupReport(applied.verify));
});

describeDb("an unverified archive is refused before any write", async () => {
  const { restoreReadIndexFromBackup } = await import(
    "../../lib/server/read-index-backup"
  );
  await assert.rejects(
    () => restoreReadIndexFromBackup(fixtureJson("checksum-mismatch.json")),
    /refusing to restore an unverified archive/,
  );
  await assert.rejects(
    () => restoreReadIndexFromBackup(fixtureJson("private-content-visible.json")),
    /refusing to restore an unverified archive/,
  );
});