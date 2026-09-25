import { Pool, neonConfig, type PoolConfig } from "@neondatabase/serverless";
import ws from "ws";

import type { ChallengeOpportunity } from "@/lib/claimDrafts";
import type { ClaimChallenger, ClaimData } from "@/lib/contract";
import type { AgentApiKeyRecord } from "@/lib/agents/api-keys";
import type { AgentTradeRow } from "@/lib/agents/performance";
import type { AgentRecord } from "@/lib/agents/registry";
import type { SpendPermissionRecord } from "@/lib/agents/spend-permissions";
import type { CopyAuditRecord, CopyPermission } from "@/lib/copy-trading";

/**
 * ADDRESS INVARIANT — read before touching any statement below.
 *
 * Every address in this schema is a Stellar strkey: a `G…` account or a `C…`
 * contract. Strkeys are CASE-SENSITIVE base32, so `toLowerCase()` on one does not
 * normalise it — it destroys it, producing a string that can never again match the
 * real address. Recipients, payers, sellers, creators, challengers and wallets are
 * therefore stored and compared VERBATIM, and no query may wrap such a column in
 * SQL `LOWER()`.
 *
 * The columns themselves need no migration: they were always plain `TEXT` holding
 * an opaque string. Only the application code was folding case.
 *
 * The one thing that IS case-normalised is a transaction hash. Those are 32-byte
 * hex, and Horizon emits them as lowercase hex — the scheme in
 * `lib/x402/stellar-scheme.ts` enforces `/^[0-9a-f]{64}$/` on the way in. Calling
 * `.toLowerCase()` on a hash is a no-op that matches reality, so it stays: it
 * keeps a hash arriving from a differently-cased source comparable.
 */

// Neon's @neondatabase/serverless uses WebSockets in Node — wire up the ws
// implementation. In edge/serverless runtimes that don't ship a global
// WebSocket, this is a no-op fallback (Vercel edge has its own native WS).
if (typeof globalThis.WebSocket === "undefined") {
  neonConfig.webSocketConstructor = ws as unknown as typeof WebSocket;
}

export interface ClaimRow {
  id: number;
  creator: string;
  question: string | null;
  creator_position: string | null;
  counter_position: string | null;
  resolution_url: string | null;
  creator_stake: number;
  total_challenger_stake: number;
  reserved_creator_liability: number;
  deadline: number;
  state: string;
  winner_side: string;
  resolution_summary: string | null;
  confidence: number;
  category: string;
  parent_id: number;
  market_type: string;
  odds_mode: string;
  challenger_payout_bps: number;
  handicap_line: string | null;
  settlement_rule: string | null;
  max_challengers: number;
  visibility: string;
  challenger_count: number;
  total_pot: number;
  first_challenger: string;
  first_indexed_at: number;
  updated_at: number;
  is_final: number;
}

export interface ChallengerRow {
  claim_id: number;
  address: string;
  stake: number;
  potential_payout: number;
}

export interface ClaimFilters {
  ids?: number[];
  creator?: string;
  categories?: string[];
  states?: string[];
  parentId?: number;
  visibility?: string;
  isFinal?: boolean;
  limit?: number;
  orderBy?: "id_desc" | "updated_desc" | "deadline_asc" | "deadline_desc";
}

export interface ChallengeOpportunityRow {
  locale: string;
  id: string;
  source_url: string;
  source_type: string;
  source_summary: string;
  category: string;
  claim_text: string;
  side_a: string;
  side_b: string;
  deadline_at: string;
  timezone: string;
  primary_resolution_source: string;
  settlement_rule: string;
  ambiguity_flags_json: string;
  confidence_score: number;
  claim_strength_score: number;
  claim_strength_tier: string;
  action: string;
  existing_claim_id: number | null;
  generated_at: number;
  expires_at: number;
}

type IndexedClaimRecord = Omit<
  ClaimRow,
  "first_indexed_at" | "updated_at" | "is_final"
>;

const PRIVATE_CONTENT_FIELDS = [
  "question",
  "creator_position",
  "counter_position",
  "resolution_url",
  "resolution_summary",
  "handicap_line",
  "settlement_rule",
] as const;

interface SqlStatement {
  sql:   string;
  args?: ReadonlyArray<unknown>;
}

/**
 * Postgres schema. BIGINT for any value that could exceed 2^31 (stakes, deadlines).
 * On-conflict syntax is identical to SQLite since Postgres 9.5.
 */
const SCHEMA_STATEMENTS: SqlStatement[] = [
  { sql: `CREATE TABLE IF NOT EXISTS schema_migrations (
    migration_id TEXT PRIMARY KEY,
    schema_version SMALLINT NOT NULL UNIQUE,
    checksum TEXT NOT NULL UNIQUE,
    applied_at BIGINT NOT NULL
  )` },
  { sql: `CREATE TABLE IF NOT EXISTS claims (
    id BIGINT PRIMARY KEY,
    creator TEXT NOT NULL,
    question TEXT,
    creator_position TEXT,
    counter_position TEXT,
    resolution_url TEXT,
    creator_stake NUMERIC NOT NULL DEFAULT 0,
    total_challenger_stake NUMERIC NOT NULL DEFAULT 0,
    reserved_creator_liability NUMERIC NOT NULL DEFAULT 0,
    deadline BIGINT NOT NULL,
    state TEXT NOT NULL DEFAULT 'open',
    winner_side TEXT NOT NULL DEFAULT '',
    resolution_summary TEXT,
    confidence INTEGER NOT NULL DEFAULT 0,
    category TEXT NOT NULL DEFAULT 'custom',
    parent_id BIGINT NOT NULL DEFAULT 0,
    market_type TEXT NOT NULL DEFAULT 'binary',
    odds_mode TEXT NOT NULL DEFAULT 'pool',
    challenger_payout_bps BIGINT NOT NULL DEFAULT 0,
    handicap_line TEXT,
    settlement_rule TEXT,
    max_challengers BIGINT NOT NULL DEFAULT 0,
    visibility TEXT NOT NULL DEFAULT 'public',
    challenger_count BIGINT NOT NULL DEFAULT 0,
    total_pot NUMERIC NOT NULL DEFAULT 0,
    first_challenger TEXT NOT NULL DEFAULT '',
    first_indexed_at BIGINT NOT NULL DEFAULT 0,
    updated_at BIGINT NOT NULL DEFAULT 0,
    is_final INTEGER NOT NULL DEFAULT 0
  )` },
  { sql: "CREATE INDEX IF NOT EXISTS idx_claims_state ON claims(state)" },
  { sql: "CREATE INDEX IF NOT EXISTS idx_claims_category ON claims(category)" },
  { sql: "CREATE INDEX IF NOT EXISTS idx_claims_creator ON claims(creator)" },
  { sql: "CREATE INDEX IF NOT EXISTS idx_claims_deadline ON claims(deadline)" },
  { sql: "CREATE INDEX IF NOT EXISTS idx_claims_parent ON claims(parent_id)" },
  { sql: "CREATE INDEX IF NOT EXISTS idx_claims_visibility ON claims(visibility)" },
  { sql: "CREATE INDEX IF NOT EXISTS idx_claims_active ON claims(state, is_final)" },
  { sql: `CREATE TABLE IF NOT EXISTS challengers (
    claim_id BIGINT NOT NULL,
    address TEXT NOT NULL,
    stake NUMERIC NOT NULL DEFAULT 0,
    potential_payout NUMERIC NOT NULL DEFAULT 0,
    PRIMARY KEY (claim_id, address)
  )` },
  { sql: "CREATE INDEX IF NOT EXISTS idx_challengers_address ON challengers(address)" },
  // Stakes/payouts are USDC decimals (e.g. 5.53), not whole numbers — BIGINT
  // columns rejected every fractional write, silently dropping challenger
  // rows (upsertChallengers wraps delete+inserts in one transaction, so a
  // single fractional stake rolled the whole claim's challenger list back).
  // Migrate pre-existing deployments that still have the BIGINT columns.
  { sql: "ALTER TABLE claims ALTER COLUMN creator_stake TYPE NUMERIC" },
  { sql: "ALTER TABLE claims ALTER COLUMN total_challenger_stake TYPE NUMERIC" },
  { sql: "ALTER TABLE claims ALTER COLUMN reserved_creator_liability TYPE NUMERIC" },
  { sql: "ALTER TABLE claims ALTER COLUMN total_pot TYPE NUMERIC" },
  { sql: "ALTER TABLE challengers ALTER COLUMN stake TYPE NUMERIC" },
  { sql: "ALTER TABLE challengers ALTER COLUMN potential_payout TYPE NUMERIC" },
  { sql: `CREATE TABLE IF NOT EXISTS sync_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )` },
  { sql: `CREATE TABLE IF NOT EXISTS challenge_opportunities (
    locale TEXT NOT NULL,
    id TEXT NOT NULL,
    source_url TEXT NOT NULL,
    source_type TEXT NOT NULL,
    source_summary TEXT NOT NULL,
    category TEXT NOT NULL,
    claim_text TEXT NOT NULL,
    side_a TEXT NOT NULL,
    side_b TEXT NOT NULL,
    deadline_at TEXT NOT NULL,
    timezone TEXT NOT NULL,
    primary_resolution_source TEXT NOT NULL,
    settlement_rule TEXT NOT NULL,
    ambiguity_flags_json TEXT NOT NULL DEFAULT '[]',
    confidence_score INTEGER NOT NULL DEFAULT 0,
    claim_strength_score INTEGER NOT NULL DEFAULT 0,
    claim_strength_tier TEXT NOT NULL DEFAULT 'weak',
    action TEXT NOT NULL DEFAULT 'create',
    existing_claim_id BIGINT,
    generated_at BIGINT NOT NULL DEFAULT 0,
    expires_at BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (locale, id)
  )` },
  { sql: "CREATE INDEX IF NOT EXISTS idx_challenge_opportunities_locale ON challenge_opportunities(locale)" },
  { sql: "CREATE INDEX IF NOT EXISTS idx_challenge_opportunities_expires_at ON challenge_opportunities(expires_at)" },
  { sql: "CREATE INDEX IF NOT EXISTS idx_challenge_opportunities_action ON challenge_opportunities(action)" },
  // Append-only agent reasoning log. A reasoning event is a claim about what an
  // agent believed at a point in time, so rows are never rewritten: corrections
  // are new events and withdrawals set tombstoned_at, keeping the audit trail.
  { sql: `CREATE TABLE IF NOT EXISTS agent_reasoning_events (
    event_id TEXT PRIMARY KEY,
    schema_version SMALLINT NOT NULL DEFAULT 1,
    claim_id BIGINT NOT NULL,
    agent_id TEXT NOT NULL,
    track TEXT NOT NULL,
    stage TEXT NOT NULL,
    position TEXT NOT NULL,
    confidence_bps INTEGER NOT NULL DEFAULT 0,
    summary TEXT NOT NULL,
    uncertainty TEXT NOT NULL DEFAULT '',
    evidence_refs_json TEXT NOT NULL DEFAULT '[]',
    model TEXT,
    provider TEXT,
    prompt_version INTEGER,
    payment_identifier TEXT,
    visibility TEXT NOT NULL DEFAULT 'public',
    safety_findings_json TEXT NOT NULL DEFAULT '[]',
    created_at BIGINT NOT NULL DEFAULT 0,
    tombstoned_at BIGINT,
    tombstone_reason TEXT
  )` },
  { sql: "CREATE INDEX IF NOT EXISTS idx_reasoning_claim ON agent_reasoning_events(claim_id, created_at)" },
  { sql: "CREATE INDEX IF NOT EXISTS idx_reasoning_agent ON agent_reasoning_events(agent_id)" },
  { sql: "CREATE INDEX IF NOT EXISTS idx_reasoning_track ON agent_reasoning_events(track)" },
  { sql: "CREATE INDEX IF NOT EXISTS idx_reasoning_visibility ON agent_reasoning_events(visibility)" },
  { sql: `CREATE TABLE IF NOT EXISTS agent_registry (
    agent_id TEXT PRIMARY KEY,
    schema_version SMALLINT NOT NULL,
    owner_wallet TEXT NOT NULL,
    operator_wallet TEXT NOT NULL,
    payout_wallet TEXT NOT NULL,
    display_name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    metadata_uri TEXT,
    metadata_hash TEXT,
    authority_level SMALLINT NOT NULL DEFAULT 0,
    limits_json TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'pending',
    reputation_bps INTEGER NOT NULL DEFAULT 0,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    revoked_at BIGINT,
    revoked_reason TEXT
  )` },
  { sql: "CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_registry_owner_id ON agent_registry(owner_wallet, agent_id)" },
  { sql: "CREATE INDEX IF NOT EXISTS idx_agent_registry_operator ON agent_registry(operator_wallet)" },
  { sql: `CREATE TABLE IF NOT EXISTS agent_operators (
    agent_id TEXT NOT NULL,
    operator_wallet TEXT NOT NULL,
    valid_from BIGINT NOT NULL,
    valid_to BIGINT,
    PRIMARY KEY(agent_id, operator_wallet, valid_from)
  )` },
  { sql: `CREATE TABLE IF NOT EXISTS agent_capabilities (
    agent_id TEXT NOT NULL,
    capability TEXT NOT NULL,
    granted_at BIGINT NOT NULL,
    revoked_at BIGINT,
    PRIMARY KEY(agent_id, capability, granted_at)
  )` },
  { sql: `CREATE TABLE IF NOT EXISTS agent_api_nonces (
    nonce TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    consumed_at BIGINT NOT NULL,
    -- Epoch ms at which this nonce is no longer a live replay risk. Rows with
    -- expires_at <= now() are garbage and pruned by pruneExpiredNonces().
    expires_at BIGINT NOT NULL DEFAULT 0
  )` },
  // Migrate pre-existing deployments that do not yet have expires_at.
  // DEFAULT 0 means old rows are treated as already-expired, which is correct:
  // a nonce consumed before this migration was applied cannot be replayed
  // (the envelope skew window has long since closed) and should be pruned.
  { sql: "ALTER TABLE agent_api_nonces ADD COLUMN IF NOT EXISTS expires_at BIGINT NOT NULL DEFAULT 0" },
  { sql: "CREATE INDEX IF NOT EXISTS idx_agent_api_nonces_expires ON agent_api_nonces(expires_at)" },
  { sql: `CREATE TABLE IF NOT EXISTS agent_api_keys (
    key_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    /** SHA-256 of the presented secret. The secret itself is shown once, at issue. */
    key_hash TEXT NOT NULL,
    /** First characters, for "which key is this?" without revealing it. */
    key_prefix TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    created_at BIGINT NOT NULL,
    last_used_at BIGINT,
    revoked_at BIGINT,
    revoked_reason TEXT
  )` },
  { sql: "CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_api_keys_hash ON agent_api_keys(key_hash)" },
  { sql: "CREATE INDEX IF NOT EXISTS idx_agent_api_keys_agent ON agent_api_keys(agent_id)" },
  // Rotation support: keys can now carry an expiry so the old key stays valid
  // through the overlap window after rotation. Idempotent ALTER TABLE: Postgres
  // ignores the statement when the column already exists.
  { sql: "ALTER TABLE agent_api_keys ADD COLUMN IF NOT EXISTS expires_at BIGINT" },
  { sql: `CREATE TABLE IF NOT EXISTS agent_spend_permissions (
    permission_hash TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    account TEXT NOT NULL,
    spender TEXT NOT NULL,
    token TEXT NOT NULL,
    allowance_atomic NUMERIC(78,0) NOT NULL,
    period_seconds BIGINT NOT NULL,
    start_at BIGINT NOT NULL,
    end_at BIGINT NOT NULL,
    salt TEXT NOT NULL DEFAULT '0',
    extra_data TEXT NOT NULL DEFAULT '0x',
    signature TEXT NOT NULL,
    permission_json TEXT NOT NULL,
    created_at BIGINT NOT NULL,
    revoked_at BIGINT,
    revoked_reason TEXT
  )` },
  { sql: "CREATE INDEX IF NOT EXISTS idx_agent_spend_permissions_agent ON agent_spend_permissions(agent_id)" },
  { sql: `CREATE TABLE IF NOT EXISTS agent_spend_ledger (
    entry_id TEXT PRIMARY KEY,
    permission_hash TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    amount_atomic NUMERIC(78,0) NOT NULL,
    /** Start of the permission period this entry counts against. */
    period_start BIGINT NOT NULL,
    intent TEXT NOT NULL,
    transaction_hash TEXT,
    created_at BIGINT NOT NULL
  )` },
  { sql: "CREATE INDEX IF NOT EXISTS idx_agent_spend_ledger_period ON agent_spend_ledger(permission_hash, period_start)" },
  { sql: `CREATE TABLE IF NOT EXISTS user_baskets (
    basket_id TEXT PRIMARY KEY,
    creator_wallet TEXT NOT NULL,
    name TEXT NOT NULL,
    thesis TEXT NOT NULL DEFAULT '',
    /** [{ agentId, weightBps }] — validated before insert, stored verbatim. */
    members_json TEXT NOT NULL,
    created_at BIGINT NOT NULL
  )` },
  { sql: "CREATE INDEX IF NOT EXISTS idx_user_baskets_creator ON user_baskets(creator_wallet)" },
  { sql: `CREATE TABLE IF NOT EXISTS basket_subscriptions (
    basket_id TEXT NOT NULL,
    subscriber TEXT NOT NULL,
    /** What the subscriber mirrors per market, in display USDC. */
    per_market_usdc NUMERIC NOT NULL DEFAULT 0,
    created_at BIGINT NOT NULL,
    revoked_at BIGINT,
    PRIMARY KEY(basket_id, subscriber)
  )` },
  { sql: "CREATE INDEX IF NOT EXISTS idx_basket_subs_basket ON basket_subscriptions(basket_id)" },
  { sql: `CREATE TABLE IF NOT EXISTS agent_request_audit (
    request_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    action TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    signed_at BIGINT NOT NULL,
    nonce TEXT NOT NULL,
    outcome TEXT NOT NULL,
    reason TEXT,
    created_at BIGINT NOT NULL,
    UNIQUE(agent_id, action, idempotency_key)
  )` },
  { sql: "CREATE INDEX IF NOT EXISTS idx_agent_audit_created ON agent_request_audit(created_at DESC)" },
  { sql: `CREATE TABLE IF NOT EXISTS agent_api_responses (
    agent_id TEXT NOT NULL,
    action TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    response_json TEXT NOT NULL,
    status_code INTEGER NOT NULL,
    created_at BIGINT NOT NULL,
    PRIMARY KEY(agent_id, action, idempotency_key)
  )` },
  // Social follow is intentionally separate from financial authorization.
  { sql: `CREATE TABLE IF NOT EXISTS agent_follows (
    follower_wallet TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    followed_at BIGINT NOT NULL,
    unfollowed_at BIGINT,
    PRIMARY KEY(follower_wallet, agent_id, followed_at)
  )` },
  { sql: `CREATE TABLE IF NOT EXISTS copy_permissions (
    permission_id TEXT PRIMARY KEY,
    owner_wallet TEXT NOT NULL,
    execution_agent_id TEXT NOT NULL,
    signal_agent_id TEXT NOT NULL,
    policy_json TEXT NOT NULL,
    signed_policy_hash TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    revoked_at BIGINT
  )` },
  { sql: `CREATE TABLE IF NOT EXISTS copy_executions (
    execution_id TEXT PRIMARY KEY,
    permission_id TEXT NOT NULL,
    source_position_id TEXT NOT NULL,
    signal_agent_id TEXT NOT NULL,
    execution_agent_id TEXT NOT NULL,
    source_attribution_id TEXT NOT NULL,
    status TEXT NOT NULL,
    stake_atomic NUMERIC(78,0) NOT NULL,
    simulation_block BIGINT NOT NULL,
    tx_hash TEXT,
    platform_fee_atomic NUMERIC(78,0) NOT NULL DEFAULT 0,
    owner_fee_atomic NUMERIC(78,0) NOT NULL DEFAULT 0,
    skip_reason TEXT,
    created_at BIGINT NOT NULL,
    UNIQUE(permission_id, source_position_id)
  )` },
  { sql: "CREATE INDEX IF NOT EXISTS idx_copy_executions_permission ON copy_executions(permission_id, created_at DESC)" },
  // x402 settlement ledger. Amounts are ATOMIC token units, never floats — a
  // DOUBLE PRECISION column cannot hold 6dp money without rounding drift, and
  // SUM() over it compounds it. The old float `payments` table is deliberately
  // not migrated: revenue restarts from zero on Stellar testnet USDC.
  { sql: `CREATE TABLE IF NOT EXISTS payments_v2 (
    id BIGSERIAL PRIMARY KEY,
    resource TEXT NOT NULL,
    scheme TEXT NOT NULL DEFAULT 'exact',
    network TEXT NOT NULL,
    asset_address TEXT NOT NULL,
    asset_symbol TEXT NOT NULL DEFAULT 'USDC',
    asset_decimals SMALLINT NOT NULL DEFAULT 6,
    amount_atomic NUMERIC(78,0) NOT NULL,
    payer TEXT,
    seller TEXT,
    transaction_hash TEXT,
    payment_identifier TEXT NOT NULL,
    facilitator TEXT,
    settled_at BIGINT NOT NULL DEFAULT 0,
    created_at BIGINT NOT NULL DEFAULT 0
  )` },
  // One row per x402 authorization: a retried settle must not double-count.
  { sql: "CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_v2_identifier ON payments_v2(network, payment_identifier)" },
  { sql: "CREATE INDEX IF NOT EXISTS idx_payments_v2_settled_at ON payments_v2(settled_at DESC)" },
  { sql: "CREATE INDEX IF NOT EXISTS idx_payments_v2_resource ON payments_v2(resource)" },
  { sql: "CREATE INDEX IF NOT EXISTS idx_payments_v2_seller ON payments_v2(seller)" },
  { sql: "CREATE INDEX IF NOT EXISTS idx_payments_v2_tx ON payments_v2(network, transaction_hash, resource)" },
  // The oracle's classic USDC bonus transfer is outside Soroban settlement.
  // Reserve once before submission; an ambiguous failure stays held for manual
  // reconciliation rather than risking a second transfer after a restart.
  { sql: `CREATE TABLE IF NOT EXISTS council_bonus_payouts (
    network TEXT NOT NULL,
    contract_id TEXT NOT NULL,
    claim_id BIGINT NOT NULL CHECK (claim_id > 0),
    juror_slug TEXT NOT NULL,
    recipient TEXT NOT NULL,
    amount_atomic NUMERIC(78,0) NOT NULL CHECK (amount_atomic > 0),
    settlement_tx_hash TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('reserved', 'confirmed', 'review')),
    payment_tx_hash TEXT,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    PRIMARY KEY (network, contract_id, claim_id, juror_slug)
  )` },
  // Rebuildable read-index for MimirV2 fee events. Every monetary value stays
  // in atomic USDC units; transaction hash + log index makes replay idempotent.
  { sql: `CREATE TABLE IF NOT EXISTS fee_policies (
    policy_id TEXT PRIMARY KEY,
    platform_fee_bps INTEGER NOT NULL,
    agent_owner_fee_bps INTEGER NOT NULL,
    platform_recipient TEXT NOT NULL,
    effective_at BIGINT NOT NULL,
    transaction_hash TEXT NOT NULL,
    log_index INTEGER NOT NULL,
    UNIQUE(transaction_hash, log_index)
  )` },
  { sql: `CREATE TABLE IF NOT EXISTS fee_accruals (
    accrual_id TEXT PRIMARY KEY,
    claim_id BIGINT NOT NULL,
    recipient TEXT NOT NULL,
    source TEXT NOT NULL CHECK(source IN ('platform', 'agent_owner')),
    amount_atomic NUMERIC(78,0) NOT NULL,
    claimed_atomic NUMERIC(78,0) NOT NULL DEFAULT 0,
    transaction_hash TEXT NOT NULL,
    log_index INTEGER NOT NULL,
    accrued_at BIGINT NOT NULL,
    UNIQUE(transaction_hash, log_index)
  )` },
  { sql: "CREATE INDEX IF NOT EXISTS idx_fee_accruals_recipient ON fee_accruals(recipient)" },
  { sql: "CREATE INDEX IF NOT EXISTS idx_fee_accruals_claim ON fee_accruals(claim_id)" },
  { sql: `CREATE TABLE IF NOT EXISTS fee_claims (
    claim_event_id TEXT PRIMARY KEY,
    recipient TEXT NOT NULL,
    amount_atomic NUMERIC(78,0) NOT NULL,
    transaction_hash TEXT NOT NULL,
    log_index INTEGER NOT NULL,
    claimed_at BIGINT NOT NULL,
    UNIQUE(transaction_hash, log_index)
  )` },
  { sql: "CREATE INDEX IF NOT EXISTS idx_fee_claims_recipient ON fee_claims(recipient)" },
  { sql: `CREATE TABLE IF NOT EXISTS agent_revenue_attribution (
    claim_id BIGINT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    owner_fee_recipient TEXT NOT NULL,
    transaction_hash TEXT NOT NULL,
    log_index INTEGER NOT NULL,
    attributed_at BIGINT NOT NULL,
    UNIQUE(transaction_hash, log_index)
  )` },
  { sql: `CREATE TABLE IF NOT EXISTS market_settlements (
    claim_id BIGINT PRIMARY KEY,
    gross_volume_atomic NUMERIC(78,0) NOT NULL,
    payout_atomic NUMERIC(78,0) NOT NULL,
    platform_fee_atomic NUMERIC(78,0) NOT NULL,
    agent_owner_fee_atomic NUMERIC(78,0) NOT NULL,
    dust_atomic NUMERIC(78,0) NOT NULL,
    transaction_hash TEXT NOT NULL UNIQUE,
    settled_at BIGINT NOT NULL
  )` },
  /**
   * Market-creator proposals, in the canonical mode schema (§10.4).
   *
   * Off-chain metadata, not a read-index projection: a proposal is a record of what
   * the creator DECIDED, including the ones it chose not to publish, which by
   * definition never reach the chain and so cannot be rebuilt from it. Keeping them
   * is the only way to measure shadow-mode precision against human review before
   * autonomous publishing is switched on.
   */
  { sql: `CREATE TABLE IF NOT EXISTS market_proposals (
    proposal_id TEXT PRIMARY KEY,
    created_at BIGINT NOT NULL,
    question TEXT NOT NULL,
    creator_position TEXT NOT NULL,
    counter_position TEXT NOT NULL,
    category TEXT NOT NULL,
    subject_type TEXT NOT NULL,
    settlement_mode TEXT NOT NULL,
    product_modifiers TEXT NOT NULL DEFAULT '[]',
    mode_rationale TEXT NOT NULL DEFAULT '',
    stake_policy TEXT NOT NULL DEFAULT '{}',
    context_pack_hash TEXT,
    resolution_url TEXT NOT NULL DEFAULT '',
    settlement_rule TEXT NOT NULL DEFAULT '',
    deadline BIGINT NOT NULL DEFAULT 0,
    quality_score INTEGER NOT NULL DEFAULT 0,
    preflight_verdict TEXT NOT NULL DEFAULT '{}',
    disposition TEXT NOT NULL,
    blocked_by TEXT,
    /** Set when the proposal was actually published. */
    claim_id BIGINT,
    /** Human review outcome, filled in later: agree | disagree | unreviewed. */
    review TEXT NOT NULL DEFAULT 'unreviewed'
  )` },
  { sql: "CREATE INDEX IF NOT EXISTS idx_market_proposals_created ON market_proposals(created_at DESC)" },
  { sql: "CREATE INDEX IF NOT EXISTS idx_market_proposals_disposition ON market_proposals(disposition)" },
  { sql: `CREATE TABLE IF NOT EXISTS market_series (
    series_id TEXT PRIMARY KEY,
    schema_version SMALLINT NOT NULL DEFAULT 1,
    root_claim_id BIGINT NOT NULL UNIQUE,
    best_of SMALLINT NOT NULL,
    creator_score SMALLINT NOT NULL DEFAULT 0,
    challenger_score SMALLINT NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active',
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
  )` },
  { sql: `CREATE TABLE IF NOT EXISTS profile_stats (
    profile_id TEXT PRIMARY KEY,
    schema_version SMALLINT NOT NULL DEFAULT 1,
    actor_type TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    stats_json TEXT NOT NULL DEFAULT '{}',
    source_block BIGINT NOT NULL DEFAULT 0,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    UNIQUE(actor_type, actor_id)
  )` },
  { sql: `CREATE TABLE IF NOT EXISTS conviction_scores (
    score_id TEXT PRIMARY KEY,
    schema_version SMALLINT NOT NULL DEFAULT 1,
    claim_id BIGINT NOT NULL,
    actor_id TEXT NOT NULL,
    scoring_version SMALLINT NOT NULL,
    score_atomic NUMERIC(78,0) NOT NULL,
    factors_json TEXT NOT NULL,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    UNIQUE(claim_id, actor_id, scoring_version)
  )` },
  { sql: `CREATE TABLE IF NOT EXISTS basket_definitions (
    basket_id TEXT PRIMARY KEY,
    schema_version SMALLINT NOT NULL DEFAULT 1,
    owner_wallet TEXT NOT NULL,
    name TEXT NOT NULL,
    policy_json TEXT NOT NULL,
    weights_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'virtual',
    idempotency_key TEXT NOT NULL,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    UNIQUE(owner_wallet, idempotency_key)
  )` },
  { sql: `CREATE TABLE IF NOT EXISTS basket_positions (
    position_id TEXT PRIMARY KEY,
    schema_version SMALLINT NOT NULL DEFAULT 1,
    basket_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    weight_bps INTEGER NOT NULL,
    allocated_atomic NUMERIC(78,0) NOT NULL DEFAULT 0,
    realized_pnl_atomic NUMERIC(78,0) NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    UNIQUE(basket_id, agent_id)
  )` },
  { sql: `CREATE TABLE IF NOT EXISTS basket_nav_snapshots (
    snapshot_id TEXT PRIMARY KEY,
    schema_version SMALLINT NOT NULL DEFAULT 1,
    basket_id TEXT NOT NULL,
    nav_atomic NUMERIC(78,0) NOT NULL,
    share_price_atomic NUMERIC(78,0) NOT NULL,
    high_water_mark_atomic NUMERIC(78,0) NOT NULL,
    source_block BIGINT NOT NULL,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    UNIQUE(basket_id, source_block)
  )` },
  /**
   * Append-only ownership transfer log for user_baskets.
   *
   * The transfer row is written ATOMICALLY with the owner update (same
   * transaction in transferBasket), so the audit trail can never fall out of
   * sync with the live row. Rows are never deleted or updated.
   *
   * from_wallet / to_wallet are stored verbatim — Stellar strkeys are
   * case-sensitive base32, and lowercasing them would corrupt the address.
   */
  { sql: `CREATE TABLE IF NOT EXISTS basket_ownership_transfers (
    transfer_id TEXT PRIMARY KEY,
    basket_id TEXT NOT NULL,
    from_wallet TEXT NOT NULL,
    to_wallet TEXT NOT NULL,
    transferred_at BIGINT NOT NULL,
    /**
     * Client-generated nonce from the signed transfer message. UNIQUE enforces
     * that the same signed authorisation cannot be submitted twice — even if
     * ownership later cycles back to the original wallet, the old nonce is
     * permanently consumed. Mirrors the agent_api_nonces pattern.
     */
    nonce TEXT NOT NULL,
    UNIQUE(nonce)
  )` },
  { sql: "CREATE INDEX IF NOT EXISTS idx_basket_transfers_basket ON basket_ownership_transfers(basket_id, transferred_at DESC)" },
  { sql: "CREATE INDEX IF NOT EXISTS idx_basket_transfers_from ON basket_ownership_transfers(from_wallet)" },
  { sql: "CREATE INDEX IF NOT EXISTS idx_basket_transfers_to ON basket_ownership_transfers(to_wallet)" },
  {
    sql: "INSERT INTO schema_migrations(migration_id, schema_version, checksum, applied_at) VALUES($1, $2, $3, $4) ON CONFLICT(schema_version) DO NOTHING",
    args: ["base-platform-schema-v2", 2, "market-series-profile-conviction-baskets-v2", 0],
  },
  {
    sql: "INSERT INTO sync_meta(key, value) VALUES($1, $2) ON CONFLICT(key) DO NOTHING",
    args: ["last_claim_count", "0"],
  },
  {
    sql: "INSERT INTO sync_meta(key, value) VALUES($1, $2) ON CONFLICT(key) DO NOTHING",
    args: ["last_sync_at", "0"],
  },
];

declare global {
  // eslint-disable-next-line no-var
  var __mimirDbPool:  Pool | undefined;
  // eslint-disable-next-line no-var
  var __mimirDbReady: Promise<Pool> | undefined;
}

export function isDbConfigured(): boolean {
  return Boolean((process.env.DATABASE_URL ?? process.env.TURSO_DATABASE_URL)?.trim());
}

function getDbConnectionString(): string {
  const url = (process.env.DATABASE_URL ?? process.env.TURSO_DATABASE_URL)?.trim();
  if (!url) throw new Error("DATABASE_URL is not configured");
  return url;
}

function buildPool(): Pool {
  const cfg: PoolConfig = { connectionString: getDbConnectionString() };
  return new Pool(cfg);
}

/** Convert `?` placeholders to Postgres `$1, $2, ...` in source order. */
function toPg(sql: string): string {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

async function execute(
  pool: Pool,
  stmt: SqlStatement,
): Promise<{ rows: Array<Record<string, unknown>> }> {
  const args = stmt.args ?? [];
  const sql = stmt.sql.includes("$") ? stmt.sql : toPg(stmt.sql);
  const result = await pool.query(sql, args as unknown[]);
  return { rows: result.rows as Array<Record<string, unknown>> };
}

async function ensureSchema(pool: Pool): Promise<void> {
  for (const stmt of SCHEMA_STATEMENTS) {
    await execute(pool, stmt);
  }
}

async function batchWrite(pool: Pool, statements: SqlStatement[]): Promise<void> {
  if (statements.length === 0) return;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const stmt of statements) {
      const sql = stmt.sql.includes("$") ? stmt.sql : toPg(stmt.sql);
      await client.query(sql, (stmt.args ?? []) as unknown[]);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

function getNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && value.length > 0) return Number(value);
  return 0;
}

function getString(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  return String(value);
}

function getNullableString(value: unknown): string | null {
  if (value == null) return null;
  return String(value);
}

function normalizeClaimRow(row: Record<string, unknown>): ClaimRow {
  return {
    id: getNumber(row.id),
    creator: getString(row.creator),
    question: getNullableString(row.question),
    creator_position: getNullableString(row.creator_position),
    counter_position: getNullableString(row.counter_position),
    resolution_url: getNullableString(row.resolution_url),
    creator_stake: getNumber(row.creator_stake),
    total_challenger_stake: getNumber(row.total_challenger_stake),
    reserved_creator_liability: getNumber(row.reserved_creator_liability),
    deadline: getNumber(row.deadline),
    state: getString(row.state),
    winner_side: getString(row.winner_side),
    resolution_summary: getNullableString(row.resolution_summary),
    confidence: getNumber(row.confidence),
    category: getString(row.category),
    parent_id: getNumber(row.parent_id),
    market_type: getString(row.market_type),
    odds_mode: getString(row.odds_mode),
    challenger_payout_bps: getNumber(row.challenger_payout_bps),
    handicap_line: getNullableString(row.handicap_line),
    settlement_rule: getNullableString(row.settlement_rule),
    max_challengers: getNumber(row.max_challengers),
    visibility: getString(row.visibility),
    challenger_count: getNumber(row.challenger_count),
    total_pot: getNumber(row.total_pot),
    first_challenger: getString(row.first_challenger),
    first_indexed_at: getNumber(row.first_indexed_at),
    updated_at: getNumber(row.updated_at),
    is_final: getNumber(row.is_final),
  };
}

function normalizeChallengerRow(row: Record<string, unknown>): ChallengerRow {
  return {
    claim_id: getNumber(row.claim_id),
    address: getString(row.address),
    stake: getNumber(row.stake),
    potential_payout: getNumber(row.potential_payout),
  };
}

function normalizeChallengeOpportunityRow(
  row: Record<string, unknown>
): ChallengeOpportunityRow {
  return {
    locale: getString(row.locale),
    id: getString(row.id),
    source_url: getString(row.source_url),
    source_type: getString(row.source_type),
    source_summary: getString(row.source_summary),
    category: getString(row.category),
    claim_text: getString(row.claim_text),
    side_a: getString(row.side_a),
    side_b: getString(row.side_b),
    deadline_at: getString(row.deadline_at),
    timezone: getString(row.timezone),
    primary_resolution_source: getString(row.primary_resolution_source),
    settlement_rule: getString(row.settlement_rule),
    ambiguity_flags_json: getString(row.ambiguity_flags_json),
    confidence_score: getNumber(row.confidence_score),
    claim_strength_score: getNumber(row.claim_strength_score),
    claim_strength_tier: getString(row.claim_strength_tier),
    action: getString(row.action),
    existing_claim_id:
      row.existing_claim_id == null ? null : getNumber(row.existing_claim_id),
    generated_at: getNumber(row.generated_at),
    expires_at: getNumber(row.expires_at),
  };
}

function buildIndexedClaimRecord(claim: ClaimData): IndexedClaimRecord {
  const visibility = claim.visibility ?? (claim.is_private ? "private" : "public");
  const isPrivate = visibility === "private" || Boolean(claim.is_private);

  const content: Record<(typeof PRIVATE_CONTENT_FIELDS)[number], string | null> = {
    question: claim.question,
    creator_position: claim.creator_position,
    counter_position: claim.counter_position,
    resolution_url: claim.resolution_url,
    resolution_summary: claim.resolution_summary,
    handicap_line: claim.handicap_line,
    settlement_rule: claim.settlement_rule,
  };

  if (isPrivate) {
    for (const field of PRIVATE_CONTENT_FIELDS) {
      content[field] = null;
    }
  }

  return {
    id: claim.id,
    creator: claim.creator,
    question: content.question,
    creator_position: content.creator_position,
    counter_position: content.counter_position,
    resolution_url: content.resolution_url,
    creator_stake: claim.creator_stake,
    total_challenger_stake: claim.total_challenger_stake,
    reserved_creator_liability: claim.reserved_creator_liability,
    deadline: claim.deadline,
    state: claim.state,
    winner_side: claim.winner_side,
    resolution_summary: content.resolution_summary,
    confidence: claim.confidence,
    category: claim.category,
    parent_id: claim.parent_id,
    market_type: claim.market_type,
    odds_mode: claim.odds_mode,
    challenger_payout_bps: claim.challenger_payout_bps,
    handicap_line: content.handicap_line,
    settlement_rule: content.settlement_rule,
    max_challengers: claim.max_challengers,
    visibility,
    challenger_count: claim.challenger_count,
    total_pot: claim.total_pot,
    first_challenger: claim.first_challenger ?? claim.challenger_addresses?.[0] ?? "",
  };
}

function buildClaimUpsertStatement(claim: ClaimData, timestamp: number): SqlStatement {
  const record = buildIndexedClaimRecord(claim);
  return {
    sql: `INSERT INTO claims (
      id, creator, question, creator_position, counter_position, resolution_url,
      creator_stake, total_challenger_stake, reserved_creator_liability,
      deadline, state, winner_side, resolution_summary, confidence, category,
      parent_id, market_type, odds_mode, challenger_payout_bps, handicap_line,
      settlement_rule, max_challengers, visibility, challenger_count, total_pot,
      first_challenger, first_indexed_at, updated_at, is_final
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      creator = excluded.creator,
      question = excluded.question,
      creator_position = excluded.creator_position,
      counter_position = excluded.counter_position,
      resolution_url = excluded.resolution_url,
      creator_stake = excluded.creator_stake,
      total_challenger_stake = excluded.total_challenger_stake,
      reserved_creator_liability = excluded.reserved_creator_liability,
      deadline = excluded.deadline,
      state = excluded.state,
      winner_side = excluded.winner_side,
      resolution_summary = excluded.resolution_summary,
      confidence = excluded.confidence,
      category = excluded.category,
      parent_id = excluded.parent_id,
      market_type = excluded.market_type,
      odds_mode = excluded.odds_mode,
      challenger_payout_bps = excluded.challenger_payout_bps,
      handicap_line = excluded.handicap_line,
      settlement_rule = excluded.settlement_rule,
      max_challengers = excluded.max_challengers,
      visibility = excluded.visibility,
      challenger_count = excluded.challenger_count,
      total_pot = excluded.total_pot,
      first_challenger = excluded.first_challenger,
      first_indexed_at = CASE
        WHEN claims.first_indexed_at > 0 THEN claims.first_indexed_at
        ELSE excluded.first_indexed_at
      END,
      updated_at = excluded.updated_at,
      is_final = excluded.is_final`,
    args: [
      record.id,
      record.creator,
      record.question,
      record.creator_position,
      record.counter_position,
      record.resolution_url,
      record.creator_stake,
      record.total_challenger_stake,
      record.reserved_creator_liability,
      record.deadline,
      record.state,
      record.winner_side,
      record.resolution_summary,
      record.confidence,
      record.category,
      record.parent_id,
      record.market_type,
      record.odds_mode,
      record.challenger_payout_bps,
      record.handicap_line,
      record.settlement_rule,
      record.max_challengers,
      record.visibility,
      record.challenger_count,
      record.total_pot,
      record.first_challenger,
      timestamp,
      timestamp,
      record.state === "resolved" || record.state === "cancelled" ? 1 : 0,
    ],
  };
}

function makeListPlaceholders(values: unknown[]): string {
  return values.map(() => "?").join(", ");
}

export function getPrivateClaimFields(): string[] {
  return [...PRIVATE_CONTENT_FIELDS];
}

export async function getDb(): Promise<Pool> {
  if (!isDbConfigured()) {
    throw new Error("DATABASE_URL is not configured");
  }
  if (!globalThis.__mimirDbPool) {
    globalThis.__mimirDbPool = buildPool();
  }
  if (!globalThis.__mimirDbReady) {
    globalThis.__mimirDbReady = ensureSchema(globalThis.__mimirDbPool).then(
      () => globalThis.__mimirDbPool as Pool,
    );
  }
  return globalThis.__mimirDbReady;
}

export async function upsertClaim(claim: ClaimData): Promise<void> {
  const pool = await getDb();
  await execute(pool, buildClaimUpsertStatement(claim, Date.now()));
}

export async function upsertClaimsBatch(claims: ClaimData[]): Promise<void> {
  if (claims.length === 0) return;
  const pool = await getDb();
  const now = Date.now();
  await batchWrite(pool, claims.map((claim) => buildClaimUpsertStatement(claim, now)));
}

export async function getClaimById(id: number): Promise<ClaimRow | null> {
  const pool = await getDb();
  const result = await execute(pool, {
    sql:  "SELECT * FROM claims WHERE id = ? LIMIT 1",
    args: [id],
  });
  const row = result.rows[0];
  return row ? normalizeClaimRow(row as Record<string, unknown>) : null;
}

export async function getClaimsByFilter(filters: ClaimFilters = {}): Promise<ClaimRow[]> {
  const pool = await getDb();
  const clauses: string[] = [];
  const args: Array<string | number> = [];

  if (filters.ids && filters.ids.length > 0) {
    clauses.push(`id IN (${makeListPlaceholders(filters.ids)})`);
    args.push(...filters.ids);
  }
  if (filters.creator) {
    clauses.push("creator = ?");
    args.push(filters.creator);
  }
  if (filters.categories && filters.categories.length > 0) {
    clauses.push(`category IN (${makeListPlaceholders(filters.categories)})`);
    args.push(...filters.categories);
  }
  if (filters.states && filters.states.length > 0) {
    clauses.push(`state IN (${makeListPlaceholders(filters.states)})`);
    args.push(...filters.states);
  }
  if (typeof filters.parentId === "number") {
    clauses.push("parent_id = ?");
    args.push(filters.parentId);
  }
  if (filters.visibility) {
    clauses.push("visibility = ?");
    args.push(filters.visibility);
  }
  if (typeof filters.isFinal === "boolean") {
    clauses.push("is_final = ?");
    args.push(filters.isFinal ? 1 : 0);
  }

  let orderBy = "ORDER BY id DESC";
  switch (filters.orderBy) {
    case "updated_desc":
      orderBy = "ORDER BY updated_at DESC, id DESC";
      break;
    case "deadline_asc":
      orderBy = "ORDER BY deadline ASC, id DESC";
      break;
    case "deadline_desc":
      orderBy = "ORDER BY deadline DESC, id DESC";
      break;
    case "id_desc":
    default:
      orderBy = "ORDER BY id DESC";
      break;
  }

  const limitClause =
    typeof filters.limit === "number" && filters.limit > 0 ? " LIMIT ?" : "";
  if (limitClause) {
    args.push(filters.limit as number);
  }

  const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const result = await execute(pool, {
    sql:  `SELECT * FROM claims ${whereClause} ${orderBy}${limitClause}`,
    args,
  });
  return result.rows.map((row) => normalizeClaimRow(row as Record<string, unknown>));
}

export async function getOpenClaims(): Promise<ClaimRow[]> {
  return getClaimsByFilter({
    states: ["open", "active"],
    visibility: "public",
    orderBy: "deadline_asc",
  });
}

export async function getRecentlyResolved(limit: number): Promise<ClaimRow[]> {
  return getClaimsByFilter({
    states: ["resolved"],
    visibility: "public",
    orderBy: "updated_desc",
    limit,
  });
}

export async function getExpiringClaims(withinSeconds: number): Promise<ClaimRow[]> {
  const pool = await getDb();
  const nowSeconds = Math.floor(Date.now() / 1000);
  const result = await execute(pool, {
    sql: `SELECT * FROM claims
      WHERE visibility = ?
        AND is_final = 0
        AND state IN (?, ?)
        AND deadline >= ?
        AND deadline <= ?
      ORDER BY deadline ASC, id DESC`,
    args: ["public", "open", "active", nowSeconds, nowSeconds + withinSeconds],
  });
  return result.rows.map((row) => normalizeClaimRow(row as Record<string, unknown>));
}

/**
 * Markets whose deadline has passed and that are still unsettled.
 *
 * Two numbers, not one: a large backlog cleared promptly and a single ancient
 * stuck market are different failures wanting different responses. The age is
 * taken from the OLDEST overdue market rather than an average over settled ones,
 * because an average improves precisely when settlement is stuck.
 */
export async function getSettlementBacklog(
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<{ count: number; oldestOverdueSec: number }> {
  const pool = await getDb();
  const result = await execute(pool, {
    sql: `SELECT COUNT(*) AS overdue, MIN(deadline) AS oldest
      FROM claims
      WHERE is_final = 0
        AND state IN (?, ?)
        AND deadline < ?`,
    args: ["open", "active", nowSeconds],
  });
  const row = (result.rows[0] ?? {}) as Record<string, unknown>;
  const count = Number(row.overdue ?? 0);
  const oldest = row.oldest === null || row.oldest === undefined ? null : Number(row.oldest);
  return {
    count: Number.isFinite(count) ? count : 0,
    oldestOverdueSec: oldest === null ? 0 : Math.max(0, nowSeconds - oldest),
  };
}

export async function getClaimsByParent(parentId: number): Promise<ClaimRow[]> {
  return getClaimsByFilter({
    parentId,
    orderBy: "id_desc",
  });
}

export async function getClaimFreshness(id: number): Promise<{ updated_at: number; is_final: number } | null> {
  const pool = await getDb();
  const result = await execute(pool, {
    sql:  "SELECT updated_at, is_final FROM claims WHERE id = ? LIMIT 1",
    args: [id],
  });
  const row = result.rows[0];
  if (!row) return null;
  return {
    updated_at: getNumber((row as Record<string, unknown>).updated_at),
    is_final:   getNumber((row as Record<string, unknown>).is_final),
  };
}

export async function upsertChallengers(
  claimId: number,
  challengers: ClaimChallenger[],
): Promise<void> {
  const pool = await getDb();
  const statements: SqlStatement[] = [
    {
      sql:  "DELETE FROM challengers WHERE claim_id = ?",
      args: [claimId],
    },
    ...challengers.map((challenger) => ({
      sql: `INSERT INTO challengers(claim_id, address, stake, potential_payout)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(claim_id, address) DO UPDATE SET
          stake = excluded.stake,
          potential_payout = excluded.potential_payout`,
      args: [
        claimId,
        challenger.address,
        challenger.stake,
        challenger.potential_payout,
      ],
    })),
  ];
  await batchWrite(pool, statements);
}

export async function getChallengersByClaimId(claimId: number): Promise<ChallengerRow[]> {
  const pool = await getDb();
  const result = await execute(pool, {
    sql:  "SELECT * FROM challengers WHERE claim_id = ? ORDER BY address ASC",
    args: [claimId],
  });
  return result.rows.map((row) => normalizeChallengerRow(row as Record<string, unknown>));
}

export async function getClaimsByChallenger(address: string): Promise<number[]> {
  const pool = await getDb();
  const result = await execute(pool, {
    sql:  "SELECT claim_id FROM challengers WHERE address = ? ORDER BY claim_id DESC",
    args: [address],
  });
  return result.rows.map((row) => getNumber((row as Record<string, unknown>).claim_id));
}

export async function getSyncMeta(key: string): Promise<string | null> {
  const pool = await getDb();
  const result = await execute(pool, {
    sql:  "SELECT value FROM sync_meta WHERE key = ? LIMIT 1",
    args: [key],
  });
  const row = result.rows[0];
  return row ? getString((row as Record<string, unknown>).value) : null;
}

export async function setSyncMeta(key: string, value: string): Promise<void> {
  const pool = await getDb();
  await execute(pool, {
    sql: `INSERT INTO sync_meta(key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    args: [key, value],
  });
}

function buildChallengeOpportunityInsertStatement(args: {
  locale: string;
  opportunity: ChallengeOpportunity;
  generatedAt: number;
  expiresAt: number;
}): SqlStatement {
  return {
    sql: `INSERT INTO challenge_opportunities (
      locale, id, source_url, source_type, source_summary, category, claim_text,
      side_a, side_b, deadline_at, timezone, primary_resolution_source,
      settlement_rule, ambiguity_flags_json, confidence_score, claim_strength_score,
      claim_strength_tier, action, existing_claim_id, generated_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(locale, id) DO UPDATE SET
      source_url = excluded.source_url,
      source_type = excluded.source_type,
      source_summary = excluded.source_summary,
      category = excluded.category,
      claim_text = excluded.claim_text,
      side_a = excluded.side_a,
      side_b = excluded.side_b,
      deadline_at = excluded.deadline_at,
      timezone = excluded.timezone,
      primary_resolution_source = excluded.primary_resolution_source,
      settlement_rule = excluded.settlement_rule,
      ambiguity_flags_json = excluded.ambiguity_flags_json,
      confidence_score = excluded.confidence_score,
      claim_strength_score = excluded.claim_strength_score,
      claim_strength_tier = excluded.claim_strength_tier,
      action = excluded.action,
      existing_claim_id = excluded.existing_claim_id,
      generated_at = excluded.generated_at,
      expires_at = excluded.expires_at`,
    args: [
      args.locale,
      args.opportunity.id,
      args.opportunity.sourceUrl,
      args.opportunity.sourceType,
      args.opportunity.sourceSummary,
      args.opportunity.candidate.category,
      args.opportunity.candidate.claimText,
      args.opportunity.candidate.sideA,
      args.opportunity.candidate.sideB,
      args.opportunity.candidate.deadlineAt,
      args.opportunity.candidate.timezone,
      args.opportunity.candidate.primaryResolutionSource,
      args.opportunity.candidate.settlementRule,
      JSON.stringify(args.opportunity.candidate.ambiguityFlags ?? []),
      args.opportunity.candidate.confidenceScore,
      args.opportunity.claimStrengthScore,
      args.opportunity.claimStrengthTier,
      args.opportunity.action,
      args.opportunity.existingClaimId ?? null,
      args.generatedAt,
      args.expiresAt,
    ],
  };
}

export async function replaceChallengeOpportunities(args: {
  locale: string;
  opportunities: Array<ChallengeOpportunity & { expiresAt: number }>;
  generatedAt?: number;
}): Promise<void> {
  const pool = await getDb();
  const generatedAt = args.generatedAt ?? Date.now();
  const statements: SqlStatement[] = [
    {
      sql:  "DELETE FROM challenge_opportunities WHERE locale = ?",
      args: [args.locale],
    },
    ...args.opportunities.map((opportunity) =>
      buildChallengeOpportunityInsertStatement({
        locale: args.locale,
        opportunity,
        generatedAt,
        expiresAt: opportunity.expiresAt,
      })
    ),
  ];
  await batchWrite(pool, statements);
}

export async function pruneExpiredChallengeOpportunities(nowMs = Date.now()): Promise<void> {
  const pool = await getDb();
  await execute(pool, {
    sql:  "DELETE FROM challenge_opportunities WHERE expires_at <= ?",
    args: [nowMs],
  });
}

export async function getActiveChallengeOpportunities(args?: {
  locale?: string;
  limit?: number;
  nowMs?: number;
}): Promise<ChallengeOpportunityRow[]> {
  const pool = await getDb();
  const locale = args?.locale === "es" ? "es" : "en";
  const limit =
    typeof args?.limit === "number" && args.limit > 0 ? Math.floor(args.limit) : 6;
  const nowMs = args?.nowMs ?? Date.now();
  const result = await execute(pool, {
    sql: `SELECT * FROM challenge_opportunities
      WHERE locale = ?
        AND expires_at > ?
      ORDER BY
        CASE action WHEN 'challenge' THEN 0 ELSE 1 END ASC,
        claim_strength_score DESC,
        confidence_score DESC,
        generated_at DESC
      LIMIT ?`,
    args: [locale, nowMs, limit],
  });
  return result.rows.map((row) => normalizeChallengeOpportunityRow(row as Record<string, unknown>));
}

// ── x402 payment ledger ───────────────────────────────────────────────────────
// Durable record of every settled x402 payment. The chain settlements are the
// ultimate source of truth; this powers /revenue and survives restarts (unlike
// the in-memory ring buffer). Every amount here is ATOMIC token units.

export interface PaymentRow {
  resource: string;
  scheme: string;
  network: string;
  asset_address: string;
  asset_symbol: string;
  asset_decimals: number;
  amount_atomic: bigint;
  payer: string | null;
  seller: string | null;
  transaction_hash: string | null;
  payment_identifier: string;
  facilitator: string | null;
  settled_at: number;
  created_at: number;
}

export interface PaymentsRevenueSummary {
  totalCalls: number;
  /** Sum of amount_atomic across the ledger. */
  totalAtomic: bigint;
  uniquePayers: number;
  uniqueSellers: number;
  byResource: Array<{ resource: string; calls: number; amountAtomic: bigint }>;
  bySeller: Array<{ seller: string; calls: number; amountAtomic: bigint }>;
  recent: PaymentRow[];
}

export interface MarketSettlementRow {
  claim_id: number;
  gross_volume_atomic: bigint;
  payout_atomic: bigint;
  platform_fee_atomic: bigint;
  agent_owner_fee_atomic: bigint;
  dust_atomic: bigint;
  transaction_hash: string;
  settled_at: number;
}

export interface FeeAccrualRow {
  accrual_id: string;
  claim_id: number;
  recipient: string;
  source: "platform" | "agent_owner";
  amount_atomic: bigint;
  transaction_hash: string;
  log_index: number;
  accrued_at: number;
}

export interface FeeClaimRow {
  claim_event_id: string;
  recipient: string;
  amount_atomic: bigint;
  transaction_hash: string;
  log_index: number;
  claimed_at: number;
}

export interface MarketRevenueSummary {
  settledMarkets: number;
  grossVolumeAtomic: bigint;
  payoutAtomic: bigint;
  platformFeeAtomic: bigint;
  agentOwnerFeeAtomic: bigint;
  dustAtomic: bigint;
  unclaimedAtomic: bigint;
}

/** NUMERIC(78,0) comes back as a string from pg — parse it, never via Number(). */
function getBigInt(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(Math.trunc(value));
  if (typeof value === "string" && value.trim().length > 0) return BigInt(value.trim());
  return 0n;
}

export interface MarketProposalRow {
  proposal_id: string;
  created_at: number;
  question: string;
  creator_position: string;
  counter_position: string;
  category: string;
  subject_type: string;
  settlement_mode: string;
  product_modifiers: string[];
  mode_rationale: string;
  stake_policy: Record<string, unknown>;
  context_pack_hash: string | null;
  resolution_url: string;
  settlement_rule: string;
  deadline: number;
  quality_score: number;
  preflight_verdict: Record<string, unknown>;
  disposition: string;
  blocked_by: string | null;
  claim_id: number | null;
}

/**
 * Record a market-creator proposal.
 *
 * Idempotent on proposal_id: a worker retrying a run must not create a second
 * record of the same decision, or shadow-mode precision would be measured against
 * inflated counts.
 */
export async function insertMarketProposal(row: MarketProposalRow): Promise<void> {
  const pool = await getDb();
  await execute(pool, {
    sql: `INSERT INTO market_proposals (
      proposal_id, created_at, question, creator_position, counter_position, category,
      subject_type, settlement_mode, product_modifiers, mode_rationale, stake_policy,
      context_pack_hash, resolution_url, settlement_rule, deadline, quality_score,
      preflight_verdict, disposition, blocked_by, claim_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (proposal_id) DO NOTHING`,
    args: [
      row.proposal_id,
      row.created_at,
      row.question,
      row.creator_position,
      row.counter_position,
      row.category,
      row.subject_type,
      row.settlement_mode,
      JSON.stringify(row.product_modifiers),
      row.mode_rationale,
      JSON.stringify(row.stake_policy),
      row.context_pack_hash,
      row.resolution_url,
      row.settlement_rule,
      row.deadline,
      row.quality_score,
      JSON.stringify(row.preflight_verdict),
      row.disposition,
      row.blocked_by,
      row.claim_id,
    ],
  });
}

/** Link a published claim back to the proposal that produced it. */
export async function attachProposalClaimId(proposalId: string, claimId: number): Promise<void> {
  const pool = await getDb();
  await execute(pool, {
    sql: "UPDATE market_proposals SET claim_id = ? WHERE proposal_id = ?",
    args: [claimId, proposalId],
  });
}

/**
 * Shadow-mode precision: of the proposals a human reviewed, how many did they
 * agree with? This is the number the roadmap gates autonomous publishing on, so it
 * deliberately reports the reviewed count too — 100% of two reviews is not
 * evidence.
 */
export async function getProposalPrecision(): Promise<{
  total: number;
  reviewed: number;
  agreed: number;
  precisionBps: number | null;
}> {
  const pool = await getDb();
  const result = await execute(pool, {
    sql: `SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE review <> 'unreviewed') AS reviewed,
      COUNT(*) FILTER (WHERE review = 'agree') AS agreed
    FROM market_proposals`,
  });
  const row = (result.rows[0] ?? {}) as Record<string, unknown>;
  const total = Number(row.total ?? 0);
  const reviewed = Number(row.reviewed ?? 0);
  const agreed = Number(row.agreed ?? 0);
  return {
    total,
    reviewed,
    agreed,
    precisionBps: reviewed > 0 ? Math.round((agreed * 10_000) / reviewed) : null,
  };
}

// ── BYOA registry and request audit ─────────────────────────────────────────

export async function upsertAgentRecord(agent: AgentRecord): Promise<void> {
  const pool = await getDb();
  await execute(pool, {
    sql: `INSERT INTO agent_registry (
      agent_id, schema_version, owner_wallet, operator_wallet, payout_wallet,
      display_name, description, metadata_uri, metadata_hash, authority_level,
      limits_json, status, reputation_bps, created_at, updated_at, revoked_at, revoked_reason
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(agent_id) DO UPDATE SET
      operator_wallet=excluded.operator_wallet, payout_wallet=excluded.payout_wallet,
      display_name=excluded.display_name, description=excluded.description,
      metadata_uri=excluded.metadata_uri, metadata_hash=excluded.metadata_hash,
      authority_level=excluded.authority_level, limits_json=excluded.limits_json,
      status=excluded.status, reputation_bps=excluded.reputation_bps,
      updated_at=excluded.updated_at, revoked_at=excluded.revoked_at,
      revoked_reason=excluded.revoked_reason`,
    args: [agent.agentId, agent.schemaVersion, agent.ownerWallet,
      agent.operatorWallet, agent.payoutWallet, agent.displayName,
      agent.description, agent.metadataUri ?? null, agent.metadataHash ?? null,
      agent.authorityLevel, JSON.stringify(agent.limits), agent.status, agent.reputationBps,
      agent.createdAt, agent.updatedAt, agent.revokedAt ?? null, agent.revokedReason ?? null],
  });
  await execute(pool, {
    sql: `INSERT INTO agent_operators(agent_id, operator_wallet, valid_from)
      VALUES (?, ?, ?) ON CONFLICT DO NOTHING`,
    args: [agent.agentId, agent.operatorWallet, agent.updatedAt],
  });
  for (const capability of agent.capabilities) {
    await execute(pool, {
      sql: `INSERT INTO agent_capabilities(agent_id, capability, granted_at)
        VALUES (?, ?, ?) ON CONFLICT DO NOTHING`,
      args: [agent.agentId, capability, agent.updatedAt],
    });
  }
}

export async function getAgentRecord(agentId: string): Promise<AgentRecord | null> {
  const pool = await getDb();
  const [record, capabilities] = await Promise.all([
    execute(pool, { sql: "SELECT * FROM agent_registry WHERE agent_id = ? LIMIT 1", args: [agentId] }),
    execute(pool, { sql: `SELECT capability FROM agent_capabilities
      WHERE agent_id = ? AND revoked_at IS NULL ORDER BY capability`, args: [agentId] }),
  ]);
  const row = record.rows[0];
  if (!row) return null;
  return {
    schemaVersion: getNumber(row.schema_version), agentId: getString(row.agent_id),
    ownerWallet: getString(row.owner_wallet), operatorWallet: getString(row.operator_wallet),
    payoutWallet: getString(row.payout_wallet), displayName: getString(row.display_name),
    description: getString(row.description), metadataUri: getNullableString(row.metadata_uri) ?? undefined,
    metadataHash: getNullableString(row.metadata_hash) ?? undefined,
    capabilities: capabilities.rows.map((r) => getString(r.capability)) as AgentRecord["capabilities"],
    authorityLevel: getNumber(row.authority_level) as AgentRecord["authorityLevel"],
    limits: JSON.parse(getString(row.limits_json) || "{}") as AgentRecord["limits"],
    status: getString(row.status) as AgentRecord["status"], reputationBps: getNumber(row.reputation_bps),
    createdAt: getNumber(row.created_at), updatedAt: getNumber(row.updated_at),
    revokedAt: row.revoked_at == null ? undefined : getNumber(row.revoked_at),
    revokedReason: getNullableString(row.revoked_reason) ?? undefined,
  };
}

/**
 * Returns false on replay. The nonce insert and audit idempotency are DB-enforced.
 *
 * `expiresAt` is the epoch-ms at which this nonce is no longer a live replay
 * risk. Pass `consumedAt + NONCE_TTL_MS` (from `lib/server/nonce-store.ts`).
 * Rows whose `expires_at <= now` are dead weight and pruned by
 * `pruneExpiredNonces`.
 */
export async function consumeAgentNonce(
  agentId: string,
  nonce: string,
  at: number,
  expiresAt: number,
): Promise<boolean> {
  const pool = await getDb();
  const result = await execute(pool, {
    sql: `INSERT INTO agent_api_nonces(nonce, agent_id, consumed_at, expires_at)
      VALUES (?, ?, ?, ?) ON CONFLICT(nonce) DO NOTHING RETURNING nonce`,
    args: [nonce, agentId, at, expiresAt],
  });
  return result.rows.length === 1;
}

/**
 * Delete nonce rows that are past their expiry.
 *
 * Safe to call at any time: rows with `expires_at <= now` are outside the
 * envelope skew window and can never be presented as a valid replay again.
 * Returns the number of rows deleted.
 */
export async function pruneExpiredNonces(now: number): Promise<number> {
  const pool = await getDb();
  // Use pool.query directly so we can read rowCount, which execute() does not
  // surface (it returns { rows } only).
  const result = await pool.query(
    "DELETE FROM agent_api_nonces WHERE expires_at <= $1",
    [now],
  );
  return result.rowCount ?? 0;
}

export async function insertAgentRequestAudit(row: {
  requestId: string; agentId: string; action: string; idempotencyKey: string;
  signedAt: number; nonce: string; outcome: string; reason?: string; createdAt: number;
}): Promise<void> {
  const pool = await getDb();
  await execute(pool, {
    sql: `INSERT INTO agent_request_audit (
      request_id, agent_id, action, idempotency_key, signed_at, nonce, outcome, reason, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(agent_id, action, idempotency_key) DO NOTHING`,
    args: [row.requestId, row.agentId, row.action, row.idempotencyKey, row.signedAt,
      row.nonce, row.outcome, row.reason ?? null, row.createdAt],
  });
}

export async function getAgentApiResponse(agentId: string, action: string, key: string): Promise<{ body: unknown; status: number } | null> {
  const pool = await getDb();
  const result = await execute(pool, {
    sql: `SELECT response_json, status_code FROM agent_api_responses
      WHERE agent_id = ? AND action = ? AND idempotency_key = ? LIMIT 1`,
    args: [agentId, action, key],
  });
  const row = result.rows[0];
  return row ? { body: JSON.parse(getString(row.response_json)), status: getNumber(row.status_code) } : null;
}

export async function saveAgentApiResponse(row: {
  agentId: string; action: string; idempotencyKey: string; body: unknown; status: number; createdAt: number;
}): Promise<void> {
  const pool = await getDb();
  await execute(pool, {
    sql: `INSERT INTO agent_api_responses(agent_id, action, idempotency_key, response_json, status_code, created_at)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(agent_id, action, idempotency_key) DO NOTHING`,
    args: [row.agentId, row.action, row.idempotencyKey, JSON.stringify(row.body), row.status, row.createdAt],
  });
}

export async function saveCopyPermission(permission: CopyPermission, at = Date.now()): Promise<void> {
  const pool = await getDb();
  await execute(pool, {
    sql: `INSERT INTO copy_permissions(permission_id, owner_wallet, execution_agent_id,
      signal_agent_id, policy_json, signed_policy_hash, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(permission_id) DO UPDATE SET policy_json=excluded.policy_json,
      status=excluded.status, updated_at=excluded.updated_at,
      revoked_at=CASE WHEN excluded.status='revoked' THEN excluded.updated_at ELSE copy_permissions.revoked_at END`,
    args: [permission.permissionId, permission.ownerWallet, permission.executionAgentId,
      permission.signalAgentId, JSON.stringify(permission, (_, v) => typeof v === "bigint" ? v.toString() : v),
      permission.signedPolicyHash, permission.status, at, at],
  });
}

export async function getCopyPermission(permissionId: string): Promise<CopyPermission | null> {
  const pool = await getDb();
  const result = await execute(pool, {
    sql: "SELECT policy_json, signed_policy_hash, status FROM copy_permissions WHERE permission_id = ? LIMIT 1",
    args: [permissionId],
  });
  const row = result.rows[0];
  if (!row) return null;
  const parsed = JSON.parse(getString(row.policy_json)) as CopyPermission & {
    spendPermission: CopyPermission["spendPermission"] & { allowanceAtomic: string | bigint };
  };
  return {
    ...parsed,
    signedPolicyHash: getString(row.signed_policy_hash),
    status: getString(row.status) as CopyPermission["status"],
    spendPermission: { ...parsed.spendPermission, allowanceAtomic: BigInt(parsed.spendPermission.allowanceAtomic) },
  };
}

export async function insertCopyExecution(record: CopyAuditRecord): Promise<void> {
  const pool = await getDb();
  await execute(pool, {
    sql: `INSERT INTO copy_executions(execution_id, permission_id, source_position_id,
      signal_agent_id, execution_agent_id, source_attribution_id, status, stake_atomic,
      simulation_block, tx_hash, platform_fee_atomic, owner_fee_atomic, skip_reason, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(permission_id, source_position_id) DO NOTHING`,
    args: [record.executionId, record.permissionId, record.sourcePositionId, record.signalAgentId,
      record.executionAgentId, record.sourceAttributionId, record.status, record.stakeAtomic.toString(),
      record.simulationBlock.toString(), record.txHash?.toLowerCase() ?? null,
      record.platformFeeAtomic.toString(), record.ownerFeeAtomic.toString(), record.skipReason ?? null,
      record.createdAt],
  });
}

export async function listCopyExecutions(permissionId: string, limit = 100): Promise<Array<Record<string, unknown>>> {
  const pool = await getDb();
  const result = await execute(pool, {
    sql: `SELECT execution_id, permission_id, source_position_id, signal_agent_id,
      execution_agent_id, source_attribution_id, status, stake_atomic, simulation_block,
      tx_hash, platform_fee_atomic, owner_fee_atomic, skip_reason, created_at
      FROM copy_executions WHERE permission_id = ? ORDER BY created_at DESC LIMIT ?`,
    args: [permissionId, limit],
  });
  return result.rows;
}

export async function insertPayment(e: PaymentRow): Promise<void> {
  const pool = await getDb();
  await execute(pool, {
    sql: `INSERT INTO payments_v2 (
      resource, scheme, network, asset_address, asset_symbol, asset_decimals,
      amount_atomic, payer, seller, transaction_hash, payment_identifier,
      facilitator, settled_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(network, payment_identifier) DO NOTHING`,
    args: [
      e.resource,
      e.scheme,
      e.network,
      // `CODE:ISSUER` for a classic asset — the issuer half is a `G…` strkey, so
      // this is an address column and stays verbatim.
      e.asset_address,
      e.asset_symbol,
      e.asset_decimals,
      // NUMERIC accepts the decimal string; bigint is not a pg wire type.
      e.amount_atomic.toString(),
      e.payer ?? null,
      e.seller ?? null,
      // Hashes, not addresses: lowercase hex is what Horizon returns.
      e.transaction_hash?.toLowerCase() ?? null,
      e.payment_identifier.toLowerCase(),
      e.facilitator,
      e.settled_at,
      e.created_at,
    ],
  });
}

/** Upsert one settlement projection rebuilt from MarketSettled + FeeAccrued logs. */
export async function upsertMarketSettlement(e: MarketSettlementRow): Promise<void> {
  const pool = await getDb();
  await execute(pool, {
    sql: `INSERT INTO market_settlements (
      claim_id, gross_volume_atomic, payout_atomic, platform_fee_atomic,
      agent_owner_fee_atomic, dust_atomic, transaction_hash, settled_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(claim_id) DO UPDATE SET
      gross_volume_atomic=excluded.gross_volume_atomic,
      payout_atomic=excluded.payout_atomic,
      platform_fee_atomic=excluded.platform_fee_atomic,
      agent_owner_fee_atomic=excluded.agent_owner_fee_atomic,
      dust_atomic=excluded.dust_atomic,
      transaction_hash=excluded.transaction_hash,
      settled_at=excluded.settled_at`,
    args: [
      e.claim_id,
      e.gross_volume_atomic.toString(),
      e.payout_atomic.toString(),
      e.platform_fee_atomic.toString(),
      e.agent_owner_fee_atomic.toString(),
      e.dust_atomic.toString(),
      e.transaction_hash.toLowerCase(),
      e.settled_at,
    ],
  });
}

/** Idempotently project FeeAccrued; replaying the same block cannot duplicate revenue. */
export async function insertFeeAccrual(e: FeeAccrualRow): Promise<void> {
  const pool = await getDb();
  await execute(pool, {
    sql: `INSERT INTO fee_accruals (
      accrual_id, claim_id, recipient, source, amount_atomic,
      transaction_hash, log_index, accrued_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(transaction_hash, log_index) DO NOTHING`,
    args: [e.accrual_id, e.claim_id, e.recipient, e.source,
      e.amount_atomic.toString(), e.transaction_hash.toLowerCase(), e.log_index, e.accrued_at],
  });
}

/** Idempotently project FeeClaimed without mutating the append-only accrual ledger. */
export async function insertFeeClaim(e: FeeClaimRow): Promise<void> {
  const pool = await getDb();
  await execute(pool, {
    sql: `INSERT INTO fee_claims (
      claim_event_id, recipient, amount_atomic, transaction_hash, log_index, claimed_at
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(transaction_hash, log_index) DO NOTHING`,
    args: [e.claim_event_id, e.recipient, e.amount_atomic.toString(),
      e.transaction_hash.toLowerCase(), e.log_index, e.claimed_at],
  });
}

/** Atomic market totals. x402 is deliberately queried separately and merged at the API boundary. */
export async function getMarketRevenueSummary(): Promise<MarketRevenueSummary> {
  const pool = await getDb();
  const [settlements, accruals] = await Promise.all([
    execute(pool, {
      sql: `SELECT COUNT(*) AS markets,
        COALESCE(SUM(gross_volume_atomic), 0) AS gross,
        COALESCE(SUM(payout_atomic), 0) AS payouts,
        COALESCE(SUM(platform_fee_atomic), 0) AS platform,
        COALESCE(SUM(agent_owner_fee_atomic), 0) AS agent_owner,
        COALESCE(SUM(dust_atomic), 0) AS dust
      FROM market_settlements`,
    }),
    execute(pool, {
      sql: `SELECT GREATEST(
        COALESCE((SELECT SUM(amount_atomic) FROM fee_accruals), 0) -
        COALESCE((SELECT SUM(amount_atomic) FROM fee_claims), 0), 0
      ) AS unclaimed`,
    }),
  ]);
  const s = settlements.rows[0] ?? {};
  return {
    settledMarkets: getNumber(s.markets),
    grossVolumeAtomic: getBigInt(s.gross),
    payoutAtomic: getBigInt(s.payouts),
    platformFeeAtomic: getBigInt(s.platform),
    agentOwnerFeeAtomic: getBigInt(s.agent_owner),
    dustAtomic: getBigInt(s.dust),
    unclaimedAtomic: getBigInt(accruals.rows[0]?.unclaimed),
  };
}

export async function getAgentEarningsSummary(payoutWallet: string): Promise<{
  ownerFeesAtomic: bigint; unclaimedAtomic: bigint; x402Atomic: bigint;
}> {
  const pool = await getDb();
  // Verbatim: this is matched against recipient/seller columns that now hold the
  // exact strkey, so folding it here would find nothing.
  const wallet = payoutWallet;
  const result = await execute(pool, {
    sql: `SELECT
      COALESCE((SELECT SUM(amount_atomic) FROM fee_accruals WHERE recipient = ? AND source = 'agent_owner'), 0) AS owner_fees,
      GREATEST(
        COALESCE((SELECT SUM(amount_atomic) FROM fee_accruals WHERE recipient = ?), 0) -
        COALESCE((SELECT SUM(amount_atomic) FROM fee_claims WHERE recipient = ?), 0), 0
      ) AS unclaimed,
      COALESCE((SELECT SUM(amount_atomic) FROM payments_v2 WHERE seller = ?), 0) AS x402`,
    args: [wallet, wallet, wallet, wallet],
  });
  const row = result.rows[0] ?? {};
  return { ownerFeesAtomic: getBigInt(row.owner_fees), unclaimedAtomic: getBigInt(row.unclaimed), x402Atomic: getBigInt(row.x402) };
}

export async function getPaymentsRevenueSummary(limit = 25): Promise<PaymentsRevenueSummary> {
  const pool = await getDb();
  const [totals, byResource, bySeller, recent] = await Promise.all([
    execute(pool, {
      sql: `SELECT COUNT(*) AS calls, COALESCE(SUM(amount_atomic), 0) AS atomic,
              COUNT(DISTINCT payer) FILTER (WHERE payer IS NOT NULL) AS payers,
              COUNT(DISTINCT seller) FILTER (WHERE seller IS NOT NULL) AS sellers
            FROM payments_v2`,
    }),
    execute(pool, {
      sql: `SELECT resource, COUNT(*) AS calls, COALESCE(SUM(amount_atomic), 0) AS atomic
            FROM payments_v2 GROUP BY resource ORDER BY atomic DESC`,
    }),
    execute(pool, {
      sql: `SELECT seller, COUNT(*) AS calls, COALESCE(SUM(amount_atomic), 0) AS atomic
            FROM payments_v2
            WHERE seller IS NOT NULL
            GROUP BY seller
            ORDER BY atomic DESC`,
    }),
    execute(pool, {
      sql: `SELECT resource, scheme, network, asset_address, asset_symbol, asset_decimals,
              amount_atomic, payer, seller, transaction_hash, payment_identifier,
              facilitator, settled_at, created_at
            FROM payments_v2 ORDER BY settled_at DESC, id DESC LIMIT ?`,
      args: [limit],
    }),
  ]);
  const t = totals.rows[0] ?? {};
  return {
    totalCalls: getNumber(t.calls),
    totalAtomic: getBigInt(t.atomic),
    uniquePayers: getNumber(t.payers),
    uniqueSellers: getNumber(t.sellers),
    byResource: byResource.rows.map((r) => ({
      resource: getString(r.resource),
      calls: getNumber(r.calls),
      amountAtomic: getBigInt(r.atomic),
    })),
    bySeller: bySeller.rows.map((r) => ({
      seller: getString(r.seller),
      calls: getNumber(r.calls),
      amountAtomic: getBigInt(r.atomic),
    })),
    recent: recent.rows.map((r) => ({
      resource: getString(r.resource),
      scheme: getString(r.scheme),
      network: getString(r.network),
      asset_address: getString(r.asset_address),
      asset_symbol: getString(r.asset_symbol),
      asset_decimals: getNumber(r.asset_decimals),
      amount_atomic: getBigInt(r.amount_atomic),
      payer: getNullableString(r.payer),
      seller: getNullableString(r.seller),
      transaction_hash: getNullableString(r.transaction_hash),
      payment_identifier: getString(r.payment_identifier),
      facilitator: getNullableString(r.facilitator),
      settled_at: getNumber(r.settled_at),
      created_at: getNumber(r.created_at),
    })),
  };
}

// ── Agent reasoning feed ──────────────────────────────────────────────────────
// Append-only. insertReasoningEvent is idempotent on the deterministic event_id,
// so a worker retry cannot duplicate a juror's published rationale.

export interface ReasoningEventRow {
  event_id: string;
  schema_version: number;
  claim_id: number;
  agent_id: string;
  track: string;
  stage: string;
  position: string;
  confidence_bps: number;
  summary: string;
  uncertainty: string;
  evidence_refs_json: string;
  model: string | null;
  provider: string | null;
  prompt_version: number | null;
  payment_identifier: string | null;
  visibility: string;
  safety_findings_json: string;
  created_at: number;
  tombstoned_at: number | null;
  tombstone_reason: string | null;
}

function normalizeReasoningRow(row: Record<string, unknown>): ReasoningEventRow {
  return {
    event_id: getString(row.event_id),
    schema_version: getNumber(row.schema_version),
    claim_id: getNumber(row.claim_id),
    agent_id: getString(row.agent_id),
    track: getString(row.track),
    stage: getString(row.stage),
    position: getString(row.position),
    confidence_bps: getNumber(row.confidence_bps),
    summary: getString(row.summary),
    uncertainty: getString(row.uncertainty),
    evidence_refs_json: getString(row.evidence_refs_json),
    model: getNullableString(row.model),
    provider: getNullableString(row.provider),
    prompt_version: row.prompt_version == null ? null : getNumber(row.prompt_version),
    payment_identifier: getNullableString(row.payment_identifier),
    visibility: getString(row.visibility),
    safety_findings_json: getString(row.safety_findings_json),
    created_at: getNumber(row.created_at),
    tombstoned_at: row.tombstoned_at == null ? null : getNumber(row.tombstoned_at),
    tombstone_reason: getNullableString(row.tombstone_reason),
  };
}

export async function insertReasoningEvent(row: Omit<ReasoningEventRow, "tombstoned_at" | "tombstone_reason">): Promise<void> {
  const pool = await getDb();
  await execute(pool, {
    sql: `INSERT INTO agent_reasoning_events (
      event_id, schema_version, claim_id, agent_id, track, stage, position,
      confidence_bps, summary, uncertainty, evidence_refs_json, model, provider,
      prompt_version, payment_identifier, visibility, safety_findings_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(event_id) DO NOTHING`,
    args: [
      row.event_id,
      row.schema_version,
      row.claim_id,
      row.agent_id,
      row.track,
      row.stage,
      row.position,
      row.confidence_bps,
      row.summary,
      row.uncertainty,
      row.evidence_refs_json,
      row.model,
      row.provider,
      row.prompt_version,
      row.payment_identifier,
      row.visibility,
      row.safety_findings_json,
      row.created_at,
    ],
  });
}

export interface ReasoningFeedFilters {
  claimId: number;
  /** Omit to return every track. */
  track?: string;
  agentId?: string;
  stage?: string;
  limit?: number;
}

/**
 * Chronological feed for one claim. Withheld and tombstoned events are excluded
 * from the public read; they stay in the table as the audit trail.
 */
export async function getReasoningFeed(filters: ReasoningFeedFilters): Promise<ReasoningEventRow[]> {
  const pool = await getDb();
  const clauses = ["claim_id = ?", "visibility <> 'withheld'", "tombstoned_at IS NULL"];
  const args: Array<string | number> = [filters.claimId];
  if (filters.track) {
    clauses.push("track = ?");
    args.push(filters.track);
  }
  if (filters.agentId) {
    clauses.push("agent_id = ?");
    args.push(filters.agentId);
  }
  if (filters.stage) {
    clauses.push("stage = ?");
    args.push(filters.stage);
  }
  const limit = typeof filters.limit === "number" && filters.limit > 0 ? Math.floor(filters.limit) : 200;
  args.push(limit);
  const result = await execute(pool, {
    sql: `SELECT * FROM agent_reasoning_events
      WHERE ${clauses.join(" AND ")}
      ORDER BY created_at ASC, event_id ASC
      LIMIT ?`,
    args,
  });
  return result.rows.map((row) => normalizeReasoningRow(row as Record<string, unknown>));
}

/**
 * Withdraw an event. The row is kept and marked, never deleted — a deletion would
 * silently rewrite the record of what an agent said.
 */
export async function tombstoneReasoningEvent(eventId: string, reason: string): Promise<void> {
  const pool = await getDb();
  await execute(pool, {
    sql: `UPDATE agent_reasoning_events
      SET tombstoned_at = ?, tombstone_reason = ?, visibility = 'withheld'
      WHERE event_id = ? AND tombstoned_at IS NULL`,
    args: [Date.now(), reason, eventId],
  });
}

// ── Agent API keys ────────────────────────────────────────────────────────────

export async function insertAgentApiKey(record: AgentApiKeyRecord): Promise<void> {
  const pool = await getDb();
  await execute(pool, {
    sql: `INSERT INTO agent_api_keys (
      key_id, agent_id, key_hash, key_prefix, label, created_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [record.keyId, record.agentId, record.keyHash, record.keyPrefix,
      record.label, record.createdAt, record.expiresAt ?? null],
  });
}

function toApiKeyRecord(row: Record<string, unknown>): AgentApiKeyRecord {
  return {
    keyId: getString(row.key_id),
    agentId: getString(row.agent_id),
    keyHash: getString(row.key_hash),
    keyPrefix: getString(row.key_prefix),
    label: getString(row.label),
    createdAt: getNumber(row.created_at),
    lastUsedAt: row.last_used_at == null ? undefined : getNumber(row.last_used_at),
    expiresAt: row.expires_at == null ? undefined : getNumber(row.expires_at),
    revokedAt: row.revoked_at == null ? undefined : getNumber(row.revoked_at),
    revokedReason: row.revoked_reason == null ? undefined : getString(row.revoked_reason),
  };
}

/** Looked up by hash: the plaintext key is never stored, so it cannot be searched. */
export async function getAgentApiKeyByHash(keyHash: string): Promise<AgentApiKeyRecord | null> {
  const pool = await getDb();
  const result = await execute(pool, {
    sql: "SELECT * FROM agent_api_keys WHERE key_hash = ? LIMIT 1",
    args: [keyHash],
  });
  const row = result.rows[0];
  return row ? toApiKeyRecord(row as Record<string, unknown>) : null;
}

export async function listAgentApiKeys(agentId: string): Promise<AgentApiKeyRecord[]> {
  const pool = await getDb();
  const result = await execute(pool, {
    sql: "SELECT * FROM agent_api_keys WHERE agent_id = ? ORDER BY created_at DESC",
    args: [agentId],
  });
  return result.rows.map((row) => toApiKeyRecord(row as Record<string, unknown>));
}

/**
 * Best-effort last-used stamp. Deliberately not awaited by callers on the hot
 * path: a failed write here must not refuse an otherwise valid request.
 */
export async function touchAgentApiKey(keyId: string, at: number): Promise<void> {
  const pool = await getDb();
  await execute(pool, {
    sql: "UPDATE agent_api_keys SET last_used_at = ? WHERE key_id = ?",
    args: [at, keyId],
  });
}

export async function revokeAgentApiKey(
  agentId: string, keyId: string, at: number, reason: string,
): Promise<boolean> {
  const pool = await getDb();
  // RETURNING rather than a row count: `execute` exposes rows only, and a revoke
  // that reports success without having matched a row is the dangerous direction.
  const result = await execute(pool, {
    sql: `UPDATE agent_api_keys SET revoked_at = ?, revoked_reason = ?
      WHERE key_id = ? AND agent_id = ? AND revoked_at IS NULL
      RETURNING key_id`,
    args: [at, reason, keyId, agentId],
  });
  return result.rows.length > 0;
}

/**
 * Set (or clear) the expiry on an existing key without revoking it.
 *
 * Used by `rotateKey` to schedule the outgoing key's expiry at `now +
 * overlap_ms`. An already-revoked key is not modified — revocation takes
 * precedence and the key is already inaccessible.
 *
 * Returns `true` when a row was found and updated.
 */
export async function setAgentApiKeyExpiry(
  agentId: string, keyId: string, expiresAt: number | null,
): Promise<boolean> {
  const pool = await getDb();
  const result = await execute(pool, {
    sql: `UPDATE agent_api_keys SET expires_at = ?
      WHERE key_id = ? AND agent_id = ? AND revoked_at IS NULL
      RETURNING key_id`,
    args: [expiresAt, keyId, agentId],
  });
  return result.rows.length > 0;
}

// ── Agent spend permissions ───────────────────────────────────────────────────

export async function upsertSpendPermission(record: SpendPermissionRecord): Promise<void> {
  const pool = await getDb();
  await execute(pool, {
    sql: `INSERT INTO agent_spend_permissions (
      permission_hash, agent_id, account, spender, token, allowance_atomic,
      period_seconds, start_at, end_at, salt, extra_data, signature,
      permission_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(permission_hash) DO UPDATE SET
      agent_id=excluded.agent_id, signature=excluded.signature,
      permission_json=excluded.permission_json,
      revoked_at=NULL, revoked_reason=NULL`,
    args: [record.permissionHash, record.agentId, record.account, record.spender,
      record.token, record.allowanceAtomic.toString(), record.periodSeconds,
      record.startAt, record.endAt, record.salt, record.extraData, record.signature,
      record.permissionJson, record.createdAt],
  });
}

function toSpendPermission(row: Record<string, unknown>): SpendPermissionRecord {
  return {
    permissionHash: getString(row.permission_hash),
    agentId: getString(row.agent_id),
    // Plain strings: `SpendPermissionRecord` types these as `string` because a
    // Stellar account/spender/token is a `G…`/`C…` strkey, not a 0x-prefixed hex
    // address. The casts these lines used to carry asserted a shape no value here
    // has ever had.
    account: getString(row.account),
    spender: getString(row.spender),
    token: getString(row.token),
    allowanceAtomic: getBigInt(row.allowance_atomic),
    periodSeconds: getNumber(row.period_seconds),
    startAt: getNumber(row.start_at),
    endAt: getNumber(row.end_at),
    salt: getString(row.salt),
    extraData: getString(row.extra_data),
    signature: getString(row.signature),
    permissionJson: getString(row.permission_json),
    createdAt: getNumber(row.created_at),
    revokedAt: row.revoked_at == null ? undefined : getNumber(row.revoked_at),
    revokedReason: row.revoked_reason == null ? undefined : getString(row.revoked_reason),
  };
}

/**
 * Newest live permission for an agent. Newest wins so re-granting a wider or
 * narrower budget takes effect without the owner having to revoke the old one first.
 */
export async function getActiveSpendPermission(
  agentId: string, nowSeconds: number,
): Promise<SpendPermissionRecord | null> {
  const pool = await getDb();
  const result = await execute(pool, {
    sql: `SELECT * FROM agent_spend_permissions
      WHERE agent_id = ? AND revoked_at IS NULL AND end_at > ?
      ORDER BY created_at DESC LIMIT 1`,
    args: [agentId, nowSeconds],
  });
  const row = result.rows[0];
  return row ? toSpendPermission(row as Record<string, unknown>) : null;
}

export async function revokeSpendPermission(
  agentId: string, permissionHash: string, at: number, reason: string,
): Promise<boolean> {
  const pool = await getDb();
  const result = await execute(pool, {
    sql: `UPDATE agent_spend_permissions SET revoked_at = ?, revoked_reason = ?
      WHERE permission_hash = ? AND agent_id = ? AND revoked_at IS NULL
      RETURNING permission_hash`,
    args: [at, reason, permissionHash, agentId],
  });
  return result.rows.length > 0;
}

/** Spend recorded against the current period. Missing rows mean nothing spent yet. */
export async function getSpentInPeriod(
  permissionHash: string, periodStart: number,
): Promise<bigint> {
  const pool = await getDb();
  const result = await execute(pool, {
    sql: `SELECT COALESCE(SUM(amount_atomic), 0) AS spent FROM agent_spend_ledger
      WHERE permission_hash = ? AND period_start = ?`,
    args: [permissionHash, periodStart],
  });
  return getBigInt((result.rows[0] as Record<string, unknown> | undefined)?.spent);
}

/**
 * Reserve spend BEFORE the chain call, then stamp the tx hash after.
 *
 * Recording afterwards would let two concurrent requests each read the same
 * remaining allowance and both proceed — the classic double-spend on a budget.
 */
export async function recordSpendReservation(entry: {
  entryId: string; permissionHash: string; agentId: string; amountAtomic: bigint;
  periodStart: number; intent: string; createdAt: number;
}): Promise<void> {
  const pool = await getDb();
  await execute(pool, {
    sql: `INSERT INTO agent_spend_ledger (
      entry_id, permission_hash, agent_id, amount_atomic, period_start, intent, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [entry.entryId, entry.permissionHash, entry.agentId, entry.amountAtomic.toString(),
      entry.periodStart, entry.intent, entry.createdAt],
  });
}

export async function settleSpendReservation(entryId: string, transactionHash: string): Promise<void> {
  const pool = await getDb();
  await execute(pool, {
    sql: "UPDATE agent_spend_ledger SET transaction_hash = ? WHERE entry_id = ?",
    args: [transactionHash.toLowerCase(), entryId],
  });
}

/** Release a reservation whose chain call never landed, so the budget is not lost. */
export async function releaseSpendReservation(entryId: string): Promise<void> {
  const pool = await getDb();
  await execute(pool, {
    sql: "DELETE FROM agent_spend_ledger WHERE entry_id = ? AND transaction_hash IS NULL",
    args: [entryId],
  });
}

// ── Agent performance ─────────────────────────────────────────────────────────

/**
 * Every market an address has money in, on either side.
 *
 * One query per role rather than a UNION: the two sides carry different figures
 * (a creator faces a pooled stake, a challenger has its own computed payout) and
 * flattening them into one row shape in SQL only hides that.
 */
export async function getAgentTradeRows(address: string): Promise<AgentTradeRow[]> {
  const pool = await getDb();
  // Exact match on both sides. The `LOWER(...)` these predicates used to carry
  // could only ever match an EVM address: against a case-sensitive strkey it
  // compares a folded column to an unfolded parameter and returns nothing — and
  // it also discarded the index on those columns.
  const [created, challenged] = await Promise.all([
    execute(pool, {
      sql: `SELECT c.id, c.creator_stake, c.total_challenger_stake, c.state, c.winner_side,
        COALESCE(ms.settled_at * 1000, c.updated_at) AS settled_at, c.category, c.question
        FROM claims c LEFT JOIN market_settlements ms ON ms.claim_id = c.id
        WHERE c.creator = ? ORDER BY c.id DESC`,
      args: [address],
    }),
    execute(pool, {
      sql: `SELECT c.id, ch.stake, ch.potential_payout, c.state, c.winner_side,
        COALESCE(ms.settled_at * 1000, c.updated_at) AS settled_at, c.category, c.question
        FROM challengers ch JOIN claims c ON c.id = ch.claim_id
        LEFT JOIN market_settlements ms ON ms.claim_id = c.id
        WHERE ch.address = ? ORDER BY c.id DESC`,
      args: [address],
    }),
  ]);

  const rows: AgentTradeRow[] = [];
  for (const raw of created.rows) {
    const row = raw as Record<string, unknown>;
    rows.push({
      claimId: getNumber(row.id), role: "creator",
      stake: getNumber(row.creator_stake),
      opposingStake: getNumber(row.total_challenger_stake),
      potentialPayout: 0,
      state: getString(row.state), winnerSide: getString(row.winner_side),
      settledAt: getNumber(row.settled_at),
      category: getString(row.category), question: getString(row.question),
    });
  }
  for (const raw of challenged.rows) {
    const row = raw as Record<string, unknown>;
    rows.push({
      claimId: getNumber(row.id), role: "challenger",
      stake: getNumber(row.stake), opposingStake: 0,
      potentialPayout: getNumber(row.potential_payout),
      state: getString(row.state), winnerSide: getString(row.winner_side),
      settledAt: getNumber(row.settled_at),
      category: getString(row.category), question: getString(row.question),
    });
  }
  return rows;
}

/** Registry listing for the agents page. Revoked agents are shown, not hidden. */
export async function listAgentRecords(limit = 100): Promise<AgentRecord[]> {
  const pool = await getDb();
  const [records, capabilities] = await Promise.all([
    execute(pool, {
      sql: "SELECT * FROM agent_registry ORDER BY created_at ASC LIMIT ?",
      args: [limit],
    }),
    execute(pool, {
      sql: "SELECT agent_id, capability FROM agent_capabilities WHERE revoked_at IS NULL",
    }),
  ]);

  const byAgent = new Map<string, string[]>();
  for (const raw of capabilities.rows) {
    const row = raw as Record<string, unknown>;
    const id = getString(row.agent_id);
    byAgent.set(id, [...(byAgent.get(id) ?? []), getString(row.capability)]);
  }

  return records.rows.map((raw) => {
    const row = raw as Record<string, unknown>;
    const agentId = getString(row.agent_id);
    let limits: AgentRecord["limits"];
    try { limits = JSON.parse(getString(row.limits_json) || "{}"); }
    catch { limits = {} as AgentRecord["limits"]; }
    return {
      schemaVersion: getNumber(row.schema_version),
      agentId,
      ownerWallet: getString(row.owner_wallet),
      operatorWallet: getString(row.operator_wallet),
      payoutWallet: getString(row.payout_wallet),
      displayName: getString(row.display_name),
      description: getString(row.description),
      metadataUri: row.metadata_uri == null ? undefined : getString(row.metadata_uri),
      metadataHash: row.metadata_hash == null ? undefined : getString(row.metadata_hash),
      capabilities: (byAgent.get(agentId) ?? []) as AgentRecord["capabilities"],
      authorityLevel: getNumber(row.authority_level) as AgentRecord["authorityLevel"],
      limits,
      status: getString(row.status) as AgentRecord["status"],
      reputationBps: getNumber(row.reputation_bps),
      createdAt: getNumber(row.created_at),
      updatedAt: getNumber(row.updated_at),
      revokedAt: row.revoked_at == null ? undefined : getNumber(row.revoked_at),
      revokedReason: row.revoked_reason == null ? undefined : getString(row.revoked_reason),
    };
  });
}

// ── User-created baskets ──────────────────────────────────────────────────────

export interface StoredBasket {
  basketId: string;
  creatorWallet: string;
  name: string;
  thesis: string;
  membersJson: string;
  createdAt: number;
  subscriberCount?: number;
}

export async function insertBasket(basket: StoredBasket): Promise<void> {
  const pool = await getDb();
  await execute(pool, {
    sql: `INSERT INTO user_baskets (
      basket_id, creator_wallet, name, thesis, members_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)`,
    args: [basket.basketId, basket.creatorWallet, basket.name,
      basket.thesis, basket.membersJson, basket.createdAt],
  });
}

function toBasket(row: Record<string, unknown>): StoredBasket {
  return {
    basketId: getString(row.basket_id),
    creatorWallet: getString(row.creator_wallet),
    name: getString(row.name),
    thesis: getString(row.thesis),
    membersJson: getString(row.members_json),
    createdAt: getNumber(row.created_at),
    subscriberCount: row.subscriber_count == null ? 0 : getNumber(row.subscriber_count),
  };
}

/**
 * Baskets with their subscriber counts.
 *
 * Counted by join rather than a denormalised column: a counter that can drift is
 * a leaderboard that lies, and the table is small enough that the join is free.
 */
export async function listBaskets(limit = 100): Promise<StoredBasket[]> {
  const pool = await getDb();
  const result = await execute(pool, {
    sql: `SELECT b.*, COALESCE(s.subscribers, 0) AS subscriber_count
      FROM user_baskets b
      LEFT JOIN (
        SELECT basket_id, COUNT(*) AS subscribers
        FROM basket_subscriptions WHERE revoked_at IS NULL GROUP BY basket_id
      ) s ON s.basket_id = b.basket_id
      ORDER BY b.created_at DESC LIMIT ?`,
    args: [limit],
  });
  return result.rows.map((row) => toBasket(row as Record<string, unknown>));
}

export async function getBasket(basketId: string): Promise<StoredBasket | null> {
  const pool = await getDb();
  const result = await execute(pool, {
    sql: `SELECT b.*, COALESCE(s.subscribers, 0) AS subscriber_count
      FROM user_baskets b
      LEFT JOIN (
        SELECT basket_id, COUNT(*) AS subscribers
        FROM basket_subscriptions WHERE revoked_at IS NULL GROUP BY basket_id
      ) s ON s.basket_id = b.basket_id
      WHERE b.basket_id = ? LIMIT 1`,
    args: [basketId],
  });
  const row = result.rows[0];
  return row ? toBasket(row as Record<string, unknown>) : null;
}

export async function subscribeToBasket(args: {
  basketId: string; subscriber: string; perMarketUsdc: number; at: number;
}): Promise<void> {
  const pool = await getDb();
  await execute(pool, {
    sql: `INSERT INTO basket_subscriptions (
      basket_id, subscriber, per_market_usdc, created_at
    ) VALUES (?, ?, ?, ?)
    ON CONFLICT(basket_id, subscriber) DO UPDATE SET
      per_market_usdc = excluded.per_market_usdc,
      revoked_at = NULL`,
    args: [args.basketId, args.subscriber, args.perMarketUsdc, args.at],
  });
}

export async function unsubscribeFromBasket(basketId: string, subscriber: string, at: number): Promise<void> {
  const pool = await getDb();
  await execute(pool, {
    sql: `UPDATE basket_subscriptions SET revoked_at = ?
      WHERE basket_id = ? AND subscriber = ? AND revoked_at IS NULL`,
    args: [at, basketId, subscriber],
  });
}

export async function listBasketSubscriptions(subscriber: string): Promise<string[]> {
  const pool = await getDb();
  const result = await execute(pool, {
    sql: `SELECT basket_id FROM basket_subscriptions
      WHERE subscriber = ? AND revoked_at IS NULL`,
    args: [subscriber],
  });
  return result.rows.map((row) => getString((row as Record<string, unknown>).basket_id));
}

// ── Basket ownership transfers ────────────────────────────────────────────────

export interface BasketOwnershipTransfer {
  transferId: string;
  basketId: string;
  fromWallet: string;
  toWallet: string;
  transferredAt: number;
  /** The client-supplied nonce that was consumed for this transfer. */
  nonce: string;
}

/**
 * Atomically update creator_wallet and write an audit row.
 *
 * The update and insert run in a single transaction so the audit trail can
 * never diverge from the live owner. Both wallet values are stored verbatim:
 * Stellar strkeys are case-sensitive base32, and lowercasing them would
 * produce strings that match nothing stored.
 *
 * Returns false if `fromWallet` no longer matches the row (concurrent transfer
 * or stale client), so the caller can surface a clear conflict error rather
 * than a generic 500.
 *
 * The nonce is stored with a UNIQUE constraint. If the same signed payload is
 * submitted twice — or if ownership cycles back and an old signature is
 * replayed — the INSERT throws a unique-constraint violation and the
 * transaction rolls back, causing this function to throw. The caller (the
 * PATCH route) catches that as a 409 conflict, distinct from the false return
 * which means "owner mismatch at UPDATE time".
 */
export async function transferBasket(args: {
  transferId: string;
  basketId: string;
  fromWallet: string;
  toWallet: string;
  nonce: string;
  at: number;
}): Promise<boolean> {
  const pool = await getDb();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Conditional update: only touches the row when the current owner still
    // matches. RETURNING lets us detect whether the update actually fired.
    const update = await client.query(
      toPg(`UPDATE user_baskets SET creator_wallet = ?
        WHERE basket_id = ? AND creator_wallet = ?
        RETURNING basket_id`),
      [args.toWallet, args.basketId, args.fromWallet],
    );
    if (update.rows.length === 0) {
      await client.query("ROLLBACK");
      return false; // basket not found, or currentOwner no longer matches
    }

    // The UNIQUE(nonce) constraint here is the replay guard: inserting a nonce
    // that already exists throws, rolls the transaction back, and the caller
    // surfaces it as a conflict. This is the same atomic pattern as
    // consumeAgentNonce / agent_api_nonces.
    await client.query(
      toPg(`INSERT INTO basket_ownership_transfers
        (transfer_id, basket_id, from_wallet, to_wallet, transferred_at, nonce)
        VALUES (?, ?, ?, ?, ?, ?)`),
      [args.transferId, args.basketId, args.fromWallet, args.toWallet, args.at, args.nonce],
    );

    await client.query("COMMIT");
    return true;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Full transfer history for a basket, newest first. */
export async function getBasketTransferHistory(basketId: string): Promise<BasketOwnershipTransfer[]> {
  const pool = await getDb();
  const result = await execute(pool, {
    sql: `SELECT * FROM basket_ownership_transfers
      WHERE basket_id = ? ORDER BY transferred_at DESC`,
    args: [basketId],
  });
  return result.rows.map((raw) => {
    const row = raw as Record<string, unknown>;
    return {
      transferId: getString(row.transfer_id),
      basketId: getString(row.basket_id),
      fromWallet: getString(row.from_wallet),
      toWallet: getString(row.to_wallet),
      transferredAt: getNumber(row.transferred_at),
      nonce: getString(row.nonce),
    };
  });
}
