/**
 * Read-index cache backup — offline verification with no network credentials.
 *
 * The Neon read-index is a cache: a pure fold of chain events, never a second
 * source of truth. A backup is a checksummed, privacy-scrubbed JSON snapshot of
 * that cache. Verification is a pure function of the archive bytes — no
 * DATABASE_URL, no Soroban RPC, no Stellar seeds — so any archive can be
 * validated on a clean checkout, in CI, or inside a cold boots container, and
 * the answer is reproducible.
 *
 * Properties, each pinned by tests:
 *
 *   deterministic  serializing the same tables always produces the same bytes
 *                  and therefore the same checksum, regardless of input order
 *   self-checking  the envelope carries a SHA-256 checksum over its own
 *                  canonical payload; any tamper makes verify fail closed
 *   privacy-safe   a private claim must not carry content — the verifier
 *                  refuses a leak rather than shipping it onward
 *   schema-gated   unknown kinds or schema versions fail instead of guessing
 *
 * Envelope:
 *
 *   {
 *     schemaVersion: 1,
 *     kind: "mimir-read-index-backup",
 *     hashAlgorithm: "sha256",
 *     createdAt,            // metadata only — NOT covered by the checksum
 *     source: { … },        // metadata only — NOT covered by the checksum
 *     checksum,             // sha256 hex over the canonical `tables` payload
 *     tables: { claims, challengers, sync_meta, … }
 *   }
 *
 * The checksum deliberately excludes `createdAt`/`source`: a restore and a
 * re-backup of identical tables must produce a byte-identical checksum, which
 * is the property the restore check relies on.
 */

import { createHash } from "node:crypto";

export const CACHE_BACKUP_SCHEMA_VERSION = 1 as const;
export const CACHE_BACKUP_KIND = "mimir-read-index-backup" as const;
export const CACHE_BACKUP_HASH_ALGORITHM = "sha256" as const;

export const READ_INDEX_TABLES = [
  "claims",
  "challengers",
  "sync_meta",
  "market_settlements",
  "fee_accruals",
  "fee_claims",
  "fee_policies",
  "agent_revenue_attribution",
] as const;

export type ReadIndexTableName = (typeof READ_INDEX_TABLES)[number];

export type BackupRow = Record<string, unknown>;

export type BackupTables = { [Table in ReadIndexTableName]: BackupRow[] };

/** Private-claim content fields, matching the scrub list in lib/db.ts. */
export const PRIMARY_CONTENT_FIELDS = [
  "question",
  "creator_position",
  "counter_position",
  "resolution_url",
  "resolution_summary",
  "handicap_line",
  "settlement_rule",
] as const;

export interface BackupSource {
  contractAddress?: string;
  network?: string;
  appVersion?: string;
  [key: string]: unknown;
}

export interface ReadIndexBackup {
  schemaVersion: 1;
  kind: "mimir-read-index-backup";
  hashAlgorithm: "sha256";
  createdAt: number;
  source?: BackupSource;
  checksum: string;
  tables: BackupTables;
}

export type CacheBackupFindingCode =
  | "BACKUP_INVALID"
  | "BACKUP_KIND_MISMATCH"
  | "BACKUP_SCHEMA_UNSUPPORTED"
  | "BACKUP_MISSING_TABLE"
  | "BACKUP_UNKNOWN_TABLE"
  | "BACKUP_ROW_INVALID"
  | "BACKUP_EMPTY"
  | "BACKUP_CHECKSUM_MISMATCH"
  | "BACKUP_PRIVATE_CONTENT_LEAK";

export interface CacheBackupFinding {
  code: CacheBackupFindingCode;
  severity: "error" | "warning";
  table?: ReadIndexTableName | string;
  claimId?: number;
  message: string;
}

export interface CacheBackupReport {
  ok: boolean;
  backup: ReadIndexBackup | null;
  findings: CacheBackupFinding[];
}

const HEX64 = /^[0-9a-f]{64}$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function sha256Hex(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

/**
 * Reduce any JSON-encodable value to a canonical form so `JSON.stringify`
 * produces byte-identical bytes for semantically equal data.
 *
 * Object keys are sorted, bigints become decimal strings, non-finite numbers
 * are rejected (they would silently corrupt a checksum), and arrays of rows
 * are sorted by their canonical serialization so source row order never
 * changes the checksum. A backup taken before and after a re-index therefore
 * verifies identically.
 */
export function canonicalValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  switch (typeof value) {
    case "string":
      return value;
    case "boolean":
      return value;
    case "number":
      if (!Number.isFinite(value)) {
        throw new Error(`non-finite number cannot be canonicalized: ${value}`);
      }
      return value;
    case "bigint":
      return value.toString();
    case "object": {
      if (Array.isArray(value)) {
        return value
          .map(canonicalValue)
          .sort((a, b) => canonicalCompare(a, b));
      }
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(value).sort()) {
        out[key] = canonicalValue((value as Record<string, unknown>)[key]);
      }
      return out;
    }
    default:
      throw new Error(`unsupported value type "${typeof value}"`);
  }
}

function canonicalCompare(a: unknown, b: unknown): number {
  const sa = JSON.stringify(a);
  const sb = JSON.stringify(b);
  if (sa < sb) return -1;
  if (sa > sb) return 1;
  return 0;
}

/** Deterministic JSON string for a full tables payload. */
export function canonicalTablesJson(tables: BackupTables): string {
  return JSON.stringify(canonicalValue(tables));
}

/**
 * The archive's self-check: sha256 hex over the canonical tables payload.
 *
 * Excludes createdAt/source so a restore → re-backup of the same rows keeps the
 * same checksum — the identity the restore check compares instead of floats or
 * timestamps.
 */
export function computeBackupChecksum(tables: BackupTables): string {
  return sha256Hex(canonicalTablesJson(tables));
}

/**
 * Signature of a parsed backup. When an envelope restores its own checksum this
 * equals the archive's `checksum`; the restore check re-dumps the DB, builds
 * tables, recomputes this and compares to the archive's stored checksum.
 */
export function backupFingerprint(backup: Pick<ReadIndexBackup, "tables">): string {
  return computeBackupChecksum(backup.tables);
}

export interface MakeBackupOptions {
  createdAt?: number;
  source?: BackupSource;
}

/** Build a valid, self-consistent envelope from normalized tables. */
export function makeBackup(tables: BackupTables, opts: MakeBackupOptions = {}): ReadIndexBackup {
  return {
    schemaVersion: CACHE_BACKUP_SCHEMA_VERSION,
    kind: CACHE_BACKUP_KIND,
    hashAlgorithm: CACHE_BACKUP_HASH_ALGORITHM,
    createdAt: opts.createdAt ?? 0,
    source: opts.source,
    checksum: computeBackupChecksum(tables),
    tables,
  };
}

/** Pretty-printed serialization of a backup envelope (the artifact format). */
export function serializeBackup(backup: ReadIndexBackup): string {
  return `${JSON.stringify(backup, null, 2)}\n`;
}

function asPlainObject(value: unknown, message: string): Record<string, unknown> {
  if (!isPlainObject(value)) throw new Error(message);
  return value;
}

function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "") return Number(value);
  return fallback;
}

/**
 * Parse and structurally validate an envelope. Throws on schema failures so a
 * restore can never "soft succeed" on garbage JSON — the backup must be proven
 * before it is allowed near money-adjacent controls.
 */
export function parseBackup(raw: unknown): ReadIndexBackup {
  const parsed =
    typeof raw === "string"
      ? (JSON.parse(raw) as unknown)
      : raw;

  const envelope = asPlainObject(parsed, "backup must be a JSON object");
  if (envelope.kind !== CACHE_BACKUP_KIND) {
    throw new Error(`kind must be "${CACHE_BACKUP_KIND}"`);
  }
  if (envelope.schemaVersion !== CACHE_BACKUP_SCHEMA_VERSION) {
    throw new Error(`schemaVersion must be ${CACHE_BACKUP_SCHEMA_VERSION}`);
  }
  if (envelope.hashAlgorithm !== CACHE_BACKUP_HASH_ALGORITHM) {
    throw new Error(`hashAlgorithm must be "${CACHE_BACKUP_HASH_ALGORITHM}"`);
  }

  const tables = asPlainObject(envelope.tables, "backup.tables must be an object");
  const known = new Set<ReadIndexTableName>(READ_INDEX_TABLES);
  for (const tableName of Object.keys(tables)) {
    if (!known.has(tableName as ReadIndexTableName)) {
      throw new Error(`unknown backup table "${tableName}"`);
    }
  }
  for (const tableName of READ_INDEX_TABLES) {
    if (!(tableName in tables)) {
      throw new Error(`missing required table "${tableName}"`);
    }
    if (!Array.isArray(tables[tableName])) {
      throw new Error(`backup.tables.${tableName} must be an array`);
    }
    tables[tableName].forEach((row, index) => {
      if (!isPlainObject(row)) {
        throw new Error(`backup.tables.${tableName}[${index}] must be an object`);
      }
    });
  }

  const checksum = envelope.checksum;
  if (typeof checksum !== "string" || !HEX64.test(checksum)) {
    throw new Error("checksum must be a sha256 hex string");
  }

  return {
    schemaVersion: CACHE_BACKUP_SCHEMA_VERSION,
    kind: CACHE_BACKUP_KIND,
    hashAlgorithm: CACHE_BACKUP_HASH_ALGORITHM,
    createdAt: asNumber(envelope.createdAt),
    source: isPlainObject(envelope.source) ? (envelope.source as BackupSource) : undefined,
    checksum,
    tables: tables as BackupTables,
  };
}

function push(findings: CacheBackupFinding[], finding: CacheBackupFinding): void {
  findings.push(finding);
}

function tableRowCount(tables: BackupTables): number {
  return READ_INDEX_TABLES.reduce((sum, name) => sum + tables[name].length, 0);
}

function contentLeaksInClaim(row: BackupRow): string | null {
  if (row.visibility !== "private" && row.visibility !== "Private") return null;
  for (const field of PRIMARY_CONTENT_FIELDS) {
    const value = row[field];
    if (value !== null && value !== undefined && value !== "") {
      return field;
    }
  }
  return null;
}

/**
 * Verify a cache backup without touching the network or the database.
 *
 * Fail-closed: `ok` is true only with zero error-severity findings. Accepts raw
 * bytes (a JSON string) or a parsed value, which makes the check safe to run
 * against untrusted files in CI or in a cold restore.
 */
export function verifyCacheBackup(raw: unknown): CacheBackupReport {
  const findings: CacheBackupFinding[] = [];

  let envelope: unknown;
  try {
    envelope = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
  } catch (error) {
    return {
      ok: false,
      backup: null,
      findings: [
        {
          code: "BACKUP_INVALID",
          severity: "error",
          message: `not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
    };
  }

  if (isPlainObject(envelope)) {
    if (envelope.kind !== CACHE_BACKUP_KIND) {
      return {
        ok: false,
        backup: null,
        findings: [
          {
            code: "BACKUP_KIND_MISMATCH",
            severity: "error",
            message: `kind must be "${CACHE_BACKUP_KIND}" (got ${JSON.stringify(envelope.kind)})`,
          },
        ],
      };
    }
    if (envelope.schemaVersion !== CACHE_BACKUP_SCHEMA_VERSION) {
      return {
        ok: false,
        backup: null,
        findings: [
          {
            code: "BACKUP_SCHEMA_UNSUPPORTED",
            severity: "error",
            message:
              `schemaVersion must be ${CACHE_BACKUP_SCHEMA_VERSION} (got ${JSON.stringify(envelope.schemaVersion)}); ` +
              "re-dump with this repo's backup tooling, do not guess a shape",
          },
        ],
      };
    }
  }

  let backup: ReadIndexBackup;
  try {
    backup = parseBackup(envelope);
  } catch (error) {
    return {
      ok: false,
      backup: null,
      findings: [
        {
          code: "BACKUP_INVALID",
          severity: "error",
          message: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }

  const { tables } = backup;

  if (tableRowCount(tables) === 0) {
    push(findings, {
      code: "BACKUP_EMPTY",
      severity: "error",
      message:
        "every table is empty — refusing to treat an empty snapshot as a verified backup",
    });
  }

  for (const row of tables.claims) {
    const leaked = contentLeaksInClaim(row);
    if (leaked !== null) {
      const claimId = asNumber(row.id);
      push(findings, {
        code: "BACKUP_PRIVATE_CONTENT_LEAK",
        severity: "error",
        table: "claims",
        claimId,
        message:
          `private claim ${claimId} carries "${leaked}" in its backup row — ` +
          "read-index writes must scrub private content before storage",
      });
    }
  }

  const computed = computeBackupChecksum(tables);
  if (computed !== backup.checksum) {
    push(findings, {
      code: "BACKUP_CHECKSUM_MISMATCH",
      severity: "error",
      message:
        `checksum mismatch: archive says ${backup.checksum}, payload computes ${computed}. ` +
        "Refuse to restore — the archive was tampered with or corrupted.",
    });
  }

  return { ok: findings.every((f) => f.severity !== "error"), backup, findings };
}

/** Format a report for CLI / CI logs without echoing archive contents. */
export function formatCacheBackupReport(report: CacheBackupReport): string {
  const lines: string[] = [`cache backup: ${report.ok ? "OK" : "FAILED"}`];
  const backup = report.backup;
  if (backup) {
    const counts = READ_INDEX_TABLES
      .map((name) => `${name}=${backup.tables[name].length}`)
      .join(", ");
    lines.push(`  · ${backup.checksum.slice(0, 16)}… — ${counts}`);
  }
  for (const finding of report.findings) {
    const mark = finding.severity === "error" ? "✗" : "!";
    const where = finding.table
      ? ` [${finding.table}${finding.claimId !== undefined ? `#${finding.claimId}` : ""}]`
      : "";
    lines.push(`  ${mark}${where} ${finding.code}: ${finding.message}`);
  }
  return lines.join("\n");
}