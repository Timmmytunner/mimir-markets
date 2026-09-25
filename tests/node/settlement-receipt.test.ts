import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSettlementReceipt,
  settlementReceiptShowsFields,
} from "../../lib/settlementReceipt";
import type { VSData } from "../../lib/contract";
import type { VSCacheFreshness } from "../../lib/vs-freshness";

const CREATOR = "GCREATORXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
const CHALLENGER = "GCHALLENGERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";

function makeVs(overrides: Partial<VSData> = {}): VSData {
  return {
    id: 58,
    creator: CREATOR,
    opponent: CHALLENGER,
    question: "Will BTC close above 100k?",
    creator_position: "Yes",
    opponent_position: "No",
    resolution_url: "https://example.com/price",
    stake_amount: 5,
    deadline: 1_700_000_000,
    state: "resolved",
    winner: CREATOR,
    resolution_summary: "Price closed above threshold.",
    category: "crypto",
    winner_side: "creator",
    confidence: 91,
    settlement_rule: "Close price on example.com after deadline.",
    creator_stake: 5,
    total_challenger_stake: 3,
    total_pot: 8,
    remaining_escrow: 0,
    challenger_count: 1,
    challenger_addresses: [CHALLENGER],
    ...overrides,
  };
}

function staleFreshness(): VSCacheFreshness {
  return {
    source: "index",
    status: "stale",
    lastUpdatedAt: new Date(Date.now() - 60_000).toISOString(),
    ageMs: 60_000,
    freshnessWindowMs: 1_000,
  };
}

test("positive: resolved claim builds a complete chain-backed receipt", () => {
  const view = buildSettlementReceipt({ vs: makeVs() });
  assert.equal(view.status, "ready");
  assert.equal(view.chainBacked, true);
  assert.equal(view.claimId, 58);
  assert.equal(view.outcome, "creator");
  assert.equal(view.confidence, 91);
  assert.equal(view.sourceHost, "example.com");
  assert.equal(view.deadlineUnix, 1_700_000_000);
  assert.equal(view.totalPotUsdc, 8);
  assert.equal(view.remainingEscrowUsdc, 0);
  assert.equal(view.winnerAddress, CREATOR);
  assert.equal(view.settlementRule.includes("Close price"), true);
  assert.equal(settlementReceiptShowsFields(view), true);
});

test("negative: open claim is invalid (no receipt fields)", () => {
  const view = buildSettlementReceipt({
    vs: makeVs({ state: "open", winner_side: "", winner: "" }),
  });
  assert.equal(view.status, "invalid");
  assert.equal(view.chainBacked, false);
  assert.equal(settlementReceiptShowsFields(view), false);
});

test("negative: disconnected overrides cached settled data", () => {
  const view = buildSettlementReceipt({
    vs: makeVs(),
    disconnected: true,
  });
  assert.equal(view.status, "disconnected");
  assert.equal(view.claimId, 58);
  assert.equal(settlementReceiptShowsFields(view), false);
});

test("boundary: loading with no vs yields loading status", () => {
  const view = buildSettlementReceipt({ vs: null, loading: true });
  assert.equal(view.status, "loading");
  assert.equal(view.claimId, null);
  assert.equal(settlementReceiptShowsFields(view), false);
});

test("boundary: confidence is clamped to 0..100", () => {
  const high = buildSettlementReceipt({ vs: makeVs({ confidence: 140 }) });
  assert.equal(high.confidence, 100);
  const low = buildSettlementReceipt({ vs: makeVs({ confidence: -5 }) });
  assert.equal(low.confidence, 0);
});

test("boundary: blank winner address is omitted", () => {
  const view = buildSettlementReceipt({
    vs: makeVs({ winner: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF" }),
  });
  assert.equal(view.winnerAddress, null);
  assert.equal(view.status, "ready");
});

test("regression: stale freshness still shows fields with stale status", () => {
  const view = buildSettlementReceipt({
    vs: makeVs(),
    freshness: staleFreshness(),
  });
  assert.equal(view.status, "stale");
  assert.equal(view.freshnessStatus, "stale");
  assert.equal(settlementReceiptShowsFields(view), true);
  assert.equal(view.outcome, "creator");
});

test("regression: resolved without winner_side is dependency_failure", () => {
  const view = buildSettlementReceipt({
    vs: makeVs({ winner_side: "", winner: "" }),
  });
  assert.equal(view.status, "dependency_failure");
  assert.equal(settlementReceiptShowsFields(view), false);
});

test("regression: cancelled draw still produces a receipt", () => {
  const view = buildSettlementReceipt({
    vs: makeVs({
      state: "cancelled",
      winner_side: "draw",
      winner: "",
      remaining_escrow: 2.5,
    }),
  });
  assert.equal(view.status, "ready");
  assert.equal(view.outcome, "draw");
  assert.equal(view.remainingEscrowUsdc, 2.5);
  assert.equal(view.winnerAddress, null);
});

test("regression: source without scheme is normalized", () => {
  const view = buildSettlementReceipt({
    vs: makeVs({ resolution_url: "docs.example.org/settle" }),
  });
  assert.equal(view.sourceUrl.startsWith("https://"), true);
  assert.equal(view.sourceHost, "docs.example.org");
});
