/**
 * Stellar strkeys are case-sensitive base32. Any `toLowerCase()` applied to one
 * produces a string that will never again match the real address, so a stored
 * fee recipient, payer or seller becomes permanently unlookupable.
 *
 * These tests assert on the ARGUMENTS handed to Postgres rather than on a
 * round-tripped row, so they run without a live database: `lib/db` caches its
 * pool on `globalThis`, which lets the suite install a recording fake before the
 * module is ever imported. That is the precise boundary the bug lived at — the
 * value bound to the placeholder — so checking it here is not a weaker test than
 * a round trip, just a faster one.
 */

import assert from "node:assert/strict";
import test from "node:test";

// Strkeys are base32 over the uppercase alphabet plus 2-7, so `toUpperCase()` is
// a no-op on a valid one and `toLowerCase()` is the destructive direction — the
// one the ledger writes were applying.
const ACCOUNT_A = "GBO43ZBS4RBC2QFDKB23U6TBFEEK47ZLGSXDJSRV2H3PNQK5ZDEYXVLE";
const ACCOUNT_B = "GD2SI5PUEFKC7TONNX7OR72WMYUO7WZDSCDSIVWWXPDIDYW5OP3ETM5D";
const ACCOUNT_C = "GCIXSDPXXIJSLEVZSYFCZRNOD6GBFIFKNTEI6X2HC6LE65KUVYMGU4X5";
const CONTRACT_A = "CADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP5KR";
/** Horizon reports transaction hashes as lowercase hex; keep that convention. */
const TX_HASH = "a".repeat(64);

interface RecordedQuery {
  sql: string;
  args: unknown[];
}

const recorded: RecordedQuery[] = [];

function installFakePool(): void {
  const record = async (sql: string, args: unknown[] = []) => {
    if (!/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql.trim())) {
      recorded.push({ sql, args });
    }
    return { rows: [] as Array<Record<string, unknown>> };
  };

  const pool = {
    query: (sql: string, args: unknown[] = []) => record(sql, args),
    connect: async () => ({
      query: (sql: string, args: unknown[] = []) => record(sql, args),
      release: () => {},
    }),
  };

  process.env.DATABASE_URL = "postgres://fake/mimir";
  // Structurally a Pool only as far as `lib/db` uses one (`query` + `connect`);
  // the real Pool type carries 20-odd members this suite never reaches, and the
  // global is declared as `Pool`, so the assignment goes through an untyped view.
  const g = globalThis as unknown as Record<string, unknown>;
  g.__mimirDbPool = pool;
  g.__mimirDbReady = Promise.resolve(pool);
}

installFakePool();

/** Every string argument written for the most recent statement. */
function lastArgs(): unknown[] {
  const last = recorded[recorded.length - 1];
  assert.ok(last, "expected a statement to have been issued");
  return last.args;
}

function reset(): void {
  recorded.length = 0;
}

test("insertFeeAccrual stores the recipient strkey verbatim", async () => {
  const db = await import("../../lib/db");
  reset();
  await db.insertFeeAccrual({
    accrual_id: `${TX_HASH}:0`,
    claim_id: 42,
    recipient: ACCOUNT_A,
    source: "platform",
    amount_atomic: 1_000_000n,
    transaction_hash: TX_HASH,
    log_index: 0,
    accrued_at: 1,
  });
  assert.ok(
    lastArgs().includes(ACCOUNT_A),
    "fee accrual recipient must reach Postgres as the exact strkey",
  );
});

test("insertFeeAccrual keeps a contract recipient verbatim", async () => {
  const db = await import("../../lib/db");
  reset();
  await db.insertFeeAccrual({
    accrual_id: `${TX_HASH}:1`,
    claim_id: 42,
    recipient: CONTRACT_A,
    source: "agent_owner",
    amount_atomic: 5n,
    transaction_hash: TX_HASH,
    log_index: 1,
    accrued_at: 1,
  });
  assert.ok(lastArgs().includes(CONTRACT_A));
});

test("insertFeeClaim stores the recipient strkey verbatim", async () => {
  const db = await import("../../lib/db");
  reset();
  await db.insertFeeClaim({
    claim_event_id: `${TX_HASH}:2`,
    recipient: ACCOUNT_B,
    amount_atomic: 7n,
    transaction_hash: TX_HASH,
    log_index: 2,
    claimed_at: 1,
  });
  assert.ok(lastArgs().includes(ACCOUNT_B));
});

test("insertPayment stores payer, seller and asset issuer verbatim", async () => {
  const db = await import("../../lib/db");
  reset();
  await db.insertPayment({
    resource: "/api/oracle",
    scheme: "exact",
    network: "stellar:testnet",
    asset_address: `USDC:${ACCOUNT_C}`,
    asset_symbol: "USDC",
    asset_decimals: 6,
    amount_atomic: 10_000n,
    payer: ACCOUNT_A,
    seller: ACCOUNT_B,
    transaction_hash: TX_HASH,
    payment_identifier: TX_HASH,
    facilitator: "horizon",
    settled_at: 1,
    created_at: 1,
  });
  const args = lastArgs();
  assert.ok(args.includes(ACCOUNT_A), "payer must be stored verbatim");
  assert.ok(args.includes(ACCOUNT_B), "seller must be stored verbatim");
  assert.ok(
    args.includes(`USDC:${ACCOUNT_C}`),
    "the asset's G… issuer must be stored verbatim",
  );
});

test("upsertClaim stores creator and first challenger verbatim", async () => {
  const db = await import("../../lib/db");
  reset();
  await db.upsertClaim({
    id: 1,
    creator: ACCOUNT_A,
    question: "q",
    creator_position: "yes",
    counter_position: "no",
    resolution_url: "https://example.com",
    creator_stake: 1,
    total_challenger_stake: 0,
    reserved_creator_liability: 0,
    available_creator_liability: 1,
    deadline: 1_800_000_000,
    state: "open",
    winner_side: "",
    resolution_summary: "",
    confidence: 0,
    category: "crypto",
    parent_id: 0,
    challenger_count: 0,
    market_type: "binary",
    odds_mode: "pool",
    challenger_payout_bps: 0,
    handicap_line: "",
    settlement_rule: "",
    max_challengers: 0,
    created_at: 0,
    visibility: "public",
    is_private: false,
    challengers: [],
    first_challenger: ACCOUNT_B,
    challenger_addresses: [ACCOUNT_B],
    total_pot: 1,
  });
  const args = lastArgs();
  assert.ok(args.includes(ACCOUNT_A), "claim creator must be stored verbatim");
  assert.ok(args.includes(ACCOUNT_B), "first challenger must be stored verbatim");
});

test("upsertChallengers stores each challenger address verbatim", async () => {
  const db = await import("../../lib/db");
  reset();
  await db.upsertChallengers(1, [
    { address: ACCOUNT_A, stake: 1, potential_payout: 2 },
    { address: CONTRACT_A, stake: 3, potential_payout: 4 },
  ]);
  const written = recorded.flatMap((q) => q.args);
  assert.ok(written.includes(ACCOUNT_A));
  assert.ok(written.includes(CONTRACT_A));
});

test("getAgentEarningsSummary queries the wallet verbatim", async () => {
  const db = await import("../../lib/db");
  reset();
  await db.getAgentEarningsSummary(ACCOUNT_A);
  const args = lastArgs();
  assert.ok(
    args.every((a) => a === ACCOUNT_A),
    "a lowercased wallet can never match a stored strkey",
  );
});

test("getAgentTradeRows queries the address verbatim and does not fold in SQL", async () => {
  const db = await import("../../lib/db");
  reset();
  await db.getAgentTradeRows(ACCOUNT_A);
  for (const query of recorded) {
    assert.ok(
      query.args.includes(ACCOUNT_A),
      "the address must be bound verbatim",
    );
    assert.ok(
      !/LOWER\s*\(/i.test(query.sql),
      `SQL-side case folding cannot match a case-sensitive strkey: ${query.sql}`,
    );
  }
});

test("getAgentTradeRows prefers the chain-derived settlement timestamp", async () => {
  const db = await import("../../lib/db");
  reset();
  await db.getAgentTradeRows(ACCOUNT_A);
  assert.equal(recorded.length, 2);
  for (const query of recorded) {
    assert.match(query.sql, /market_settlements/);
    assert.match(query.sql, /COALESCE\(ms\.settled_at \* 1000, c\.updated_at\) AS settled_at/);
  }
});

test("basket creator and subscriber addresses are stored verbatim", async () => {
  const db = await import("../../lib/db");

  reset();
  await db.insertBasket({
    basketId: "momentum-abc123",
    creatorWallet: ACCOUNT_A,
    name: "Momentum",
    thesis: "",
    membersJson: "[]",
    createdAt: 1,
  });
  assert.ok(lastArgs().includes(ACCOUNT_A), "basket creator must be verbatim");

  reset();
  await db.subscribeToBasket({
    basketId: "momentum-abc123",
    subscriber: ACCOUNT_B,
    perMarketUsdc: 2,
    at: 1,
  });
  assert.ok(lastArgs().includes(ACCOUNT_B), "subscriber must be verbatim");

  reset();
  await db.unsubscribeFromBasket("momentum-abc123", ACCOUNT_B, 1);
  assert.ok(lastArgs().includes(ACCOUNT_B), "unsubscribe must match verbatim");

  reset();
  await db.listBasketSubscriptions(ACCOUNT_B);
  assert.ok(lastArgs().includes(ACCOUNT_B), "lookup must match verbatim");
});

test("agent registry wallets are stored verbatim", async () => {
  const db = await import("../../lib/db");
  reset();
  await db.upsertAgentRecord({
    schemaVersion: 1,
    agentId: "agent-1",
    ownerWallet: ACCOUNT_A,
    operatorWallet: ACCOUNT_B,
    payoutWallet: ACCOUNT_C,
    displayName: "Agent",
    description: "",
    capabilities: [],
    authorityLevel: 0,
    limits: {},
    status: "active",
    reputationBps: 0,
    createdAt: 1,
    updatedAt: 1,
  } as unknown as Parameters<typeof db.upsertAgentRecord>[0]);
  const written = recorded.flatMap((q) => q.args);
  assert.ok(written.includes(ACCOUNT_A), "owner wallet verbatim");
  assert.ok(written.includes(ACCOUNT_B), "operator wallet verbatim");
  assert.ok(written.includes(ACCOUNT_C), "payout wallet verbatim");
});

test("transaction hashes keep Horizon's lowercase-hex convention", async () => {
  const db = await import("../../lib/db");
  reset();
  await db.upsertMarketSettlement({
    claim_id: 9,
    gross_volume_atomic: 1n,
    payout_atomic: 1n,
    platform_fee_atomic: 0n,
    agent_owner_fee_atomic: 0n,
    dust_atomic: 0n,
    transaction_hash: TX_HASH,
    settled_at: 1,
  });
  assert.ok(
    lastArgs().includes(TX_HASH),
    "a Stellar tx hash is already lowercase hex off Horizon",
  );
});
