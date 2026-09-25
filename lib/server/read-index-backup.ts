/**
 * Read-index backup / restore, DB-bound half.
 *
 * The pure serialization, checksum and privacy rules live in
 * `lib/ops/cache-backup.ts` so they can be verified with zero network access.
 * This module is the only place a DATABASE_URL is touched: it reads the
 * read-index projection tables into a backup payload, and it restores a
 * verified archive back into them.
 *
 * Scope is deliberately the chain-projection tables only — claims, challengers,
 * sync_meta and the settlement/fee projection. Off-chain drafts
 * (`challenge_opportunities`, `market_proposals`) are explicitly excluded so a
 * backup never carries un-published or private source text.
 *
 * Restore is fail-closed: an unverified archive never reaches the database, and
 * after the write the read-set is fingerprinted and compared against the
 * archive's checksum so a partially-applied restore is detected rather than
 * assumed done.
 */

import { isDbConfigured, getDb } from "@/lib/db";
import type { Pool } from "@neondatabase/serverless";
import {
  CACHE_BACKUP_KIND,
  CACHE_BACKUP_SCHEMA_VERSION,
  CACHE_BACKUP_HASH_ALGORITHM,
  READ_INDEX_TABLES,
  backupFingerprint,
  computeBackupChecksum,
  makeBackup,
  serializeBackup,
  verifyCacheBackup,
  type BackupRow,
  type BackupTables,
  type CacheBackupFinding,
  type CacheBackupReport,
  type ReadIndexBackup,
  type ReadIndexTableName,
} from "@/lib/ops/cache-backup";

interface TableSpec {
  columns: string[];
  orderBy: string;
  /** PK / unique key for `ON CONFLICT` upserts. */
  conflictTarget: string;
}

/**
 * Explicit column sets — never `SELECT *` — so a future schema column cannot
 * silently change archive bytes (or worse, leak a new secret-shaped column)
 * without this list being updated on purpose.
 */
const TABLE_SPECS: Record<ReadIndexTableName, TableSpec> = {
  claims: {
    columns: [
      "id", "creator", "question", "creator_position", "counter_position",
      "resolution_url", "creator_stake", "total_challenger_stake",
      "reserved_creator_liability", "deadline", "state", "winner_side",
      "resolution_summary", "confidence", "category", "parent_id", "market_type",
      "odds_mode", "challenger_payout_bps", "handicap_line", "settlement_rule",
      "max_challengers", "visibility", "challenger_count", "total_pot",
      "first_challenger", "first_indexed_at", "updated_at", "is_final",
    ],
    orderBy: "id ASC",
    conflictTarget: "id",
  },
  challengers: {
    columns: ["claim_id", "address", "stake", "potential_payout"],
    orderBy: "claim_id ASC, address ASC",
    conflictTarget: "claim_id, address",
  },
  sync_meta: {
    columns: ["key", "value"],
    orderBy: "key ASC",
    conflictTarget: "key",
  },
  market_settlements: {
    columns: [
      "claim_id", "gross_volume_atomic", "payout_atomic", "platform_fee_atomic",
      "agent_owner_fee_atomic", "dust_atomic", "transaction_hash", "settled_at",
    ],
    orderBy: "claim_id ASC",
    conflictTarget: "claim_id",
  },
  fee_accruals: {
    columns: [
      "accrual_id", "claim_id", "recipient", "source", "amount_atomic",
      "transaction_hash", "log_index", "accrued_at",
    ],
    orderBy: "accrual_id ASC",
    conflictTarget: "accrual_id",
  },
  fee_claims: {
    columns: [
      "claim_event_id", "recipient", "amount_atomic", "transaction_hash",
      "log_index", "claimed_at",
    ],
    orderBy: "claim_event_id ASC",
    conflictTarget: "claim_event_id",
  },
  fee_policies: {
    columns: [
      "policy_id", "platform_fee_bps", "agent_owner_fee_bps", "platform_recipient",
      "effective_at", "transaction_hash", "log_index",
    ],
    orderBy: "policy_id ASC",
    conflictTarget: "policy_id",
  },
  agent_revenue_attribution: {
    columns: [
      "claim_id", "agent_id", "owner_fee_recipient", "transaction_hash",
      "log_index", "attributed_at",
    ],
    orderBy: "claim_id ASC",
    conflictTarget: "claim_id",
  },
};

function num(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "") return Number(value);
  if (typeof value === "bigint") return Number(value);
  return 0;
}

function str(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "bigint") return value.toString();
  return String(value);
}

function nullable(value: unknown): string | null {
  return value === undefined || value === null ? null : str(value);
}

/** NUMERIC(78,0) atomic amounts: keep the decimal string, never float it. */
function atomic(value: unknown): string {
  if (typeof value === "bigint") return value.toString();
  return str(value);
}

function normalizeClaimRow(row: Record<string, unknown>): BackupRow {
  return {
    id: num(row.id),
    creator: str(row.creator),
    question: nullable(row.question),
    creator_position: nullable(row.creator_position),
    counter_position: nullable(row.counter_position),
    resolution_url: nullable(row.resolution_url),
    creator_stake: num(row.creator_stake),
    total_challenger_stake: num(row.total_challenger_stake),
    reserved_creator_liability: num(row.reserved_creator_liability),
    deadline: num(row.deadline),
    state: str(row.state),
    winner_side: str(row.winner_side),
    resolution_summary: nullable(row.resolution_summary),
    confidence: num(row.confidence),
    category: str(row.category),
    parent_id: num(row.parent_id),
    market_type: str(row.market_type),
    odds_mode: str(row.odds_mode),
    challenger_payout_bps: num(row.challenger_payout_bps),
    handicap_line: nullable(row.handicap_line),
    settlement_rule: nullable(row.settlement_rule),
    max_challengers: num(row.max_challengers),
    visibility: str(row.visibility),
    challenger_count: num(row.challenger_count),
    total_pot: num(row.total_pot),
    first_challenger: str(row.first_challenger),
    first_indexed_at: num(row.first_indexed_at),
    updated_at: num(row.updated_at),
    is_final: num(row.is_final),
  };
}

function normalizeChallengerRow(row: Record<string, unknown>): BackupRow {
  return {
    claim_id: num(row.claim_id),
    address: str(row.address),
    stake: num(row.stake),
    potential_payout: num(row.potential_payout),
  };
}

function normalizeSyncMetaRow(row: Record<string, unknown>): BackupRow {
  return { key: str(row.key), value: str(row.value) };
}

function normalizeMarketSettlementRow(row: Record<string, unknown>): BackupRow {
  return {
    claim_id: num(row.claim_id),
    gross_volume_atomic: atomic(row.gross_volume_atomic),
    payout_atomic: atomic(row.payout_atomic),
    platform_fee_atomic: atomic(row.platform_fee_atomic),
    agent_owner_fee_atomic: atomic(row.agent_owner_fee_atomic),
    dust_atomic: atomic(row.dust_atomic),
    transaction_hash: str(row.transaction_hash),
    settled_at: num(row.settled_at),
  };
}

function normalizeFeeAccrualRow(row: Record<string, unknown>): BackupRow {
  return {
    accrual_id: str(row.accrual_id),
    claim_id: num(row.claim_id),
    recipient: str(row.recipient),
    source: str(row.source),
    amount_atomic: atomic(row.amount_atomic),
    transaction_hash: str(row.transaction_hash),
    log_index: num(row.log_index),
    accrued_at: num(row.accrued_at),
  };
}

function normalizeFeeClaimRow(row: Record<string, unknown>): BackupRow {
  return {
    claim_event_id: str(row.claim_event_id),
    recipient: str(row.recipient),
    amount_atomic: atomic(row.amount_atomic),
    transaction_hash: str(row.transaction_hash),
    log_index: num(row.log_index),
    claimed_at: num(row.claimed_at),
  };
}

function normalizeFeePolicyRow(row: Record<string, unknown>): BackupRow {
  return {
    policy_id: str(row.policy_id),
    platform_fee_bps: num(row.platform_fee_bps),
    agent_owner_fee_bps: num(row.agent_owner_fee_bps),
    platform_recipient: str(row.platform_recipient),
    effective_at: num(row.effective_at),
    transaction_hash: str(row.transaction_hash),
    log_index: num(row.log_index),
  };
}

function normalizeAgentAttributionRow(row: Record<string, unknown>): BackupRow {
  return {
    claim_id: num(row.claim_id),
    agent_id: str(row.agent_id),
    owner_fee_recipient: str(row.owner_fee_recipient),
    transaction_hash: str(row.transaction_hash),
    log_index: num(row.log_index),
    attributed_at: num(row.attributed_at),
  };
}

const NORMALIZERS: Record<ReadIndexTableName, (row: Record<string, unknown>) => BackupRow> = {
  claims: normalizeClaimRow,
  challengers: normalizeChallengerRow,
  sync_meta: normalizeSyncMetaRow,
  market_settlements: normalizeMarketSettlementRow,
  fee_accruals: normalizeFeeAccrualRow,
  fee_claims: normalizeFeeClaimRow,
  fee_policies: normalizeFeePolicyRow,
  agent_revenue_attribution: normalizeAgentAttributionRow,
};

async function readTable(pool: Pool, name: ReadIndexTableName): Promise<BackupRow[]> {
  const spec = TABLE_SPECS[name];
  const columns = spec.columns.join(", ");
  const result = await pool.query(
    `SELECT ${columns} FROM ${name} ORDER BY ${spec.orderBy}`,
  );
  const normalize = NORMALIZERS[name];
  return result.rows.map((row) => normalize(row as Record<string, unknown>));
}

export function requireBackupEnv(): void {
  if (!isDbConfigured()) {
    throw new Error(
      "DATABASE_URL is required — the read-index backup has nowhere to read from",
    );
  }
}

/** Fresh tables payload (all projection tables). No network/token creds needed. */
export async function readReadIndexTables(): Promise<BackupTables> {
  requireBackupEnv();
  const pool = await getDb();
  const entries = await Promise.all(
    READ_INDEX_TABLES.map(async (name) => [name, await readTable(pool, name)] as const),
  );
  return Object.fromEntries(entries) as BackupTables;
}

export interface ReadIndexBackupResult {
  backup: ReadIndexBackup;
  report: CacheBackupReport;
  /** Filename-friendly timestamp (seconds). */
  takenAt: number;
}

/**
 * Dump the read-index to a self-verified archive. The dump verifies itself
 * before returning, so a backup that reads back corrupt fails here rather than
 * shipping the corruption onward.
 */
export async function backUpReadIndex(
  opts: { source?: ReadIndexBackup["source"] } = {},
): Promise<ReadIndexBackupResult> {
  const tables = await readReadIndexTables();
  const backup = makeBackup(tables, {
    createdAt: Date.now(),
    source: opts.source,
  });
  const report = verifyCacheBackup(backup);
  if (!report.ok) {
    throw new Error(
      `rejected self-verification of a freshly taken backup:\n${report.findings
        .map((f) => `  ${f.code}: ${f.message}`)
        .join("\n")}`,
    );
  }
  return { backup, report, takenAt: backup.createdAt };
}

export async function dumpReadIndexBackup(
  opts: { source?: ReadIndexBackup["source"] } = {},
): Promise<string> {
  const { backup } = await backUpReadIndex(opts);
  return serializeBackup(backup);
}

export interface RestoreProgress {
  table: ReadIndexTableName;
  rows: number;
}

export interface ReadIndexRestoreResult {
  restored: RestoreProgress[];
  /** Archive the restore applied. */
  backup: ReadIndexBackup;
  /** Post-restore read-back verification. */
  verify: CacheBackupReport;
  /** True only when writes happened (false for --dry-run). */
  applied: boolean;
}

interface SqlValue {
  sql: string;
  args: unknown[];
}

function toPgPlaceholders(count: number): string {
  return Array.from({ length: count }, (_, i) => `$${i + 1}`).join(", ");
}

function upsertStatements(name: ReadIndexTableName, rows: BackupRow[]): SqlValue[] {
  const spec = TABLE_SPECS[name];
  const columns = spec.columns;
  const conflictTarget = spec.conflictTarget;
  const conflictColumns = conflictTarget.split(", ");
  const all = columns.join(", ");
  const parens = `(${all})`;
  const placeholders = toPgPlaceholders(columns.length);
  const updates = columns.filter((c) => !conflictColumns.includes(c));

  return rows.map((row) => {
    const args = columns.map((c) => row[c] ?? null);
    const setClause =
      updates.length > 0
        ? updates.map((c) => `${c} = excluded.${c}`).join(", ")
        : `${columns[0]} = excluded.${columns[0]}`;
    return {
      sql:
        `INSERT INTO ${name} ${parens} VALUES (${placeholders}) ` +
        `ON CONFLICT(${conflictTarget}) DO UPDATE SET ${setClause}`,
      args,
    };
  });
}

async function runInTransaction(pool: Pool, statements: SqlValue[]): Promise<void> {
  if (statements.length === 0) return;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const statement of statements) {
      await client.query(statement.sql, statement.args);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function mismatchFinding(expected: string, actual: string): CacheBackupFinding {
  return {
    code: "BACKUP_CHECKSUM_MISMATCH",
    severity: "error",
    message:
      `restore verification failed: archive fingerprint ${expected}, ` +
      `database fingerprint ${actual}. Re-apply the archive or re-warm from chain — ` +
      "the cache does not match the backup.",
  };
}

/**
 * Restore checks:
 *  - the archive must verify before a single write starts (fail-closed),
 *  - writes happen in one transaction so a failure rolls back to the pre-restore state,
 *  - after commit the tables are re-read and fingerprinted against the archive.
 * `dryRun` verifies and reports what would change without writing.
 */
export async function restoreReadIndexFromBackup(
  archiveText: string,
  opts: { dryRun?: boolean } = {},
): Promise<ReadIndexRestoreResult> {
  requireBackupEnv();
  const report = verifyCacheBackup(archiveText);
  if (!report.ok || !report.backup) {
    throw new Error(
      `refusing to restore an unverified archive:\n${report.findings
        .map((f) => `  ${f.code}: ${f.message}`)
        .join("\n")}`,
    );
  }
  const backup = report.backup;
  const pool = await getDb();

  const restored: RestoreProgress[] = [];
  if (!opts.dryRun) {
    const statements: SqlValue[] = [];
    for (const name of READ_INDEX_TABLES) {
      statements.push(...upsertStatements(name, backup.tables[name]));
    }
    await runInTransaction(pool, statements);
    for (const name of READ_INDEX_TABLES) {
      restored.push({ table: name, rows: backup.tables[name].length });
    }
  } else {
    for (const name of READ_INDEX_TABLES) {
      restored.push({ table: name, rows: backup.tables[name].length });
    }
  }

  const verify = await verifyReadIndexRestore(backup, { skipIfDryRun: Boolean(opts.dryRun) });
  return { restored, backup, verify, applied: !opts.dryRun };
}

/**
 * Verify that the current database matches an archive exactly.
 *
 * Round-trips the same projection dump the backup CLI uses and compares the
 * fingerprint to the archive's own checksum — a restored cache that drifts on
 * write (a scrubbed column, a truncated amount, a dropped row) shows up here.
 */
export async function verifyReadIndexRestore(
  backup: ReadIndexBackup,
  opts: { skipIfDryRun?: boolean } = {},
): Promise<CacheBackupReport> {
  if (opts.skipIfDryRun) {
    const emptyFindings: CacheBackupFinding[] = [];
    return {
      ok: true,
      backup: null,
      findings: emptyFindings,
    };
  }
  const tables = await readReadIndexTables();
  const actual = computeBackupChecksum(tables);
  const expected = backupFingerprint(backup);
  if (actual === expected) {
    return { ok: true, backup: null, findings: [] };
  }
  return {
    ok: false,
    backup: null,
    findings: [mismatchFinding(expected, actual)],
  };
}

/**
 * A backup archive's metadata block. Exported so the CLI can annotate dumps
 * with the network without implying the checksum covers it.
 */
export function buildBackupSource(overrides: Record<string, unknown> = {}): NonNullable<ReadIndexBackup["source"]> {
  return {
    kind: CACHE_BACKUP_KIND,
    schemaVersion: CACHE_BACKUP_SCHEMA_VERSION,
    hashAlgorithm: CACHE_BACKUP_HASH_ALGORITHM,
    ...overrides,
  };
}