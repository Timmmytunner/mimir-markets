/**
 * Settlement projection — rebuilds market_settlements / fee_accruals / fee_claims
 * from the market contract's `market_settled`, `fee_accrued`, `challenger_paid`
 * and `fee_claimed` events.
 *
 * /revenue reads these tables and they had no writer at all, so the market half of
 * the dashboard reported zero however many markets had actually settled on chain.
 * The chain is still the record; this is only the projection that makes it
 * queryable.
 *
 * Every write is idempotent (`ON CONFLICT` on the event's tx + index), so a
 * replayed range cannot double-count revenue — which is what lets the cursor be a
 * plain high-water mark instead of a transaction.
 *
 * ── What the move to Soroban actually changed here ───────────────────────────
 *
 * 1. **Settlement is no longer one event.** The EVM `resolveClaim` paid every
 *    challenger in the same call, so `MarketSettled.totalPaid` was the final
 *    number and one log per market was the whole story. A Stellar transaction is
 *    capped on its ledger-entry footprint, so challengers now PULL
 *    (`claim_challenger_payout`) and `market_settled` reports what was pushed at
 *    resolve time plus `owed_to_challengers` still in escrow. Each later pull
 *    emits `challenger_paid`. The projection therefore ACCUMULATES: a market's
 *    payout figure grows as pulls land, and gross volume has to count the escrow
 *    that has not been pulled yet or the dashboard would under-report a settled
 *    market by the whole challenger side.
 * 2. **Fees are taken at pull time too.** `fees::apply_fees` runs inside
 *    `claim_challenger_payout`, so `fee_accrued` events arrive in transactions
 *    long after the settlement. `MarketSettled.total_fees` is only the fees taken
 *    at resolve, which is why the fee columns are summed from the accrual ledger
 *    rather than read off the settlement event.
 * 3. **Paging is by cursor, not by range.** `getEvents` hands back an opaque
 *    cursor and only retains a rolling ~7-day window on Testnet, so the walk is
 *    sequential and history older than the window is simply not there. That is a
 *    property of the RPC, not of this code — durable history needs an archival
 *    indexer, and the cursor below is a high-water mark within the window.
 * 4. **An empty page does not mean the end.** Handled once, in
 *    `paginatedGetEvents` (see the long note there); this module just consumes it.
 *
 * ── Event decoding, verified against the live Testnet contract ───────────────
 *
 * A `#[contractevent]` publishes: `topic[0]` = the snake_case event name as a
 * Symbol, `topic[1..]` = the `#[topic]` fields in declaration order, and `value` =
 * a MAP of the remaining fields keyed by their snake_case names. Confirmed by
 * reading the deployed contract's own events rather than inferred from the macro:
 *
 *   topics: "market_settled" | <u64>
 *   value : { dust, owed_to_challengers, total_fees, total_paid }
 *   topics: "fee_accrued" | <u64> | "GBMG…IR2Y"
 *   value : { amount, is_agent_owner_fee }
 *   topics: "challenger_paid" | <u64> | "GDZC…X4UH"
 *   value : { fee, gross, net, stake }
 */

import { scValToNative, type rpc } from "@stellar/stellar-sdk";

import {
  getContractEvents,
  getDeployLedger,
  isMarketConfigured,
  requireMarketContractId,
} from "@/lib/stellar";
import {
  getSyncMeta,
  insertFeeAccrual,
  insertFeeClaim,
  isDbConfigured,
  setSyncMeta,
  upsertMarketSettlement,
} from "@/lib/db";

/**
 * Deliberately NOT the old `settlement_cursor_block` key.
 *
 * A stored EVM block number is a plausible-looking integer that is nowhere near
 * any Stellar ledger sequence, so reusing the key would have the first run start
 * from a nonsense floor and silently project nothing. A new key means a cold
 * start, which is correct: the old cursor described a chain that is gone.
 */
const CURSOR_KEY = "settlement_cursor_ledger";

/** Pages per reconcile pass. Each page covers ~10_000 ledgers — see lib/stellar.ts. */
const MAX_PAGES_PER_PASS = 30;

export interface SettlementSyncResult {
  settlements: number;
  accruals: number;
  claims: number;
  /** Per-challenger pull payouts folded into their market's payout total. */
  payouts: number;
  fromLedger: number;
  toLedger: number;
  /** True when the scan stopped on its page budget and should be run again. */
  truncated: boolean;
}

/**
 * Split one claim's accruals into the two fee buckets the dashboard reports.
 * Pure so the arithmetic can be tested without a chain or a database.
 */
export function splitFees(accruals: Array<{ amount: bigint; isAgentOwnerFee: boolean }>): {
  platformAtomic: bigint;
  agentOwnerAtomic: bigint;
} {
  let platformAtomic = 0n;
  let agentOwnerAtomic = 0n;
  for (const a of accruals) {
    if (a.isAgentOwnerFee) agentOwnerAtomic += a.amount;
    else platformAtomic += a.amount;
  }
  return { platformAtomic, agentOwnerAtomic };
}

/**
 * Gross volume is what the contract took in, so it is everything it then moved
 * out or still owes: winner payouts pushed at resolve, fees taken, escrow still
 * owed to challengers who have not pulled, and the rounding dust it kept.
 *
 * `owedToChallengers` is the term the EVM version did not need and this one
 * cannot omit: at resolve time it is frequently the LARGEST of the four, because
 * nothing has been pulled yet.
 */
export function grossVolume(
  totalPaid: bigint,
  totalFees: bigint,
  owedToChallengers: bigint,
  dust: bigint,
): bigint {
  return totalPaid + totalFees + owedToChallengers + dust;
}

// ── Event decoding ───────────────────────────────────────────────────────────

type EventFields = Record<string, unknown>;

interface DecodedEvent {
  name: string;
  /** `#[topic]` fields after the event name, decoded. */
  topics: unknown[];
  fields: EventFields;
  txHash: string;
  ledger: number;
  /** Unix seconds. Soroban RPC stamps every event with its ledger close time. */
  at: number;
  /**
   * Stable per-event index inside its transaction, for the `ON CONFLICT`
   * uniqueness the fee tables rely on. Soroban RPC has no `logIndex`, but the
   * event id is `"<TOID>-<index>"` and the trailing number is exactly that index.
   */
  index: number;
}

function decodeEvent(event: rpc.Api.EventResponse): DecodedEvent | null {
  const topics = event.topic ?? [];
  if (topics.length === 0) return null;

  let name: string;
  try {
    name = String(scValToNative(topics[0]));
  } catch {
    return null;
  }

  const decodedTopics: unknown[] = [];
  for (const topic of topics.slice(1)) {
    try {
      decodedTopics.push(scValToNative(topic));
    } catch {
      decodedTopics.push(null);
    }
  }

  let fields: EventFields = {};
  try {
    const value = scValToNative(event.value);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      fields = value as EventFields;
    }
  } catch {
    // A field this projection does not read may fail to decode; the topics still
    // identify the event, and a missing amount is caught by the `?? null` guards.
  }

  const indexPart = event.id?.split("-")[1];
  return {
    name,
    topics: decodedTopics,
    fields,
    txHash: event.txHash ?? "",
    ledger: Number(event.ledger ?? 0),
    at: Math.floor(new Date(event.ledgerClosedAt ?? 0).getTime() / 1000),
    index: /^\d+$/.test(indexPart ?? "") ? Number(indexPart) : 0,
  };
}

function asBigInt(value: unknown): bigint | null {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isFinite(value)) return BigInt(Math.trunc(value));
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return BigInt(value.trim());
  return null;
}

function asClaimId(value: unknown): number | null {
  const n = asBigInt(value);
  return n === null ? null : Number(n);
}

// ── Reconcile ────────────────────────────────────────────────────────────────

interface MarketTotals {
  claimId: number;
  paid: bigint;
  feesAtResolve: bigint;
  owed: bigint;
  dust: bigint;
  txHash: string;
  settledAt: number;
}

export async function reconcileSettlements(): Promise<SettlementSyncResult> {
  const empty: SettlementSyncResult = {
    settlements: 0, accruals: 0, claims: 0, payouts: 0,
    fromLedger: 0, toLedger: 0, truncated: false,
  };
  if (!isDbConfigured() || !isMarketConfigured()) return empty;

  const contractId = requireMarketContractId();

  const stored = Number(await getSyncMeta(CURSOR_KEY).catch(() => null));
  // Re-read the cursor ledger itself: a scan that stopped mid-ledger would
  // otherwise drop the events after the one it happened to stop on. Replaying is
  // free because every write is idempotent.
  const fromLedger = Number.isFinite(stored) && stored > 0 ? stored : getDeployLedger();

  const scan = await getContractEvents(contractId, {
    startLedger: fromLedger,
    maxPages: MAX_PAGES_PER_PASS,
  });

  const result: SettlementSyncResult = {
    ...empty,
    fromLedger,
    toLedger: scan.latestLedger,
    truncated: scan.truncated,
  };

  const decoded = scan.events
    .map(decodeEvent)
    .filter((event): event is DecodedEvent => event !== null);

  // Accruals are grouped by claim so a settlement can find its own fee legs. On
  // Soroban they are NOT necessarily in the settlement's transaction — a pull
  // months later accrues fees for the same claim — so the grouping spans the whole
  // scan rather than one block's logs.
  const accrualsByClaim = new Map<number, Array<{ amount: bigint; isAgentOwnerFee: boolean }>>();
  const pulledByClaim = new Map<number, bigint>();
  const settlements: MarketTotals[] = [];

  for (const event of decoded) {
    switch (event.name) {
      case "fee_accrued": {
        const claimId = asClaimId(event.topics[0]);
        const recipient = typeof event.topics[1] === "string" ? event.topics[1] : "";
        const amount = asBigInt(event.fields.amount);
        if (claimId === null || amount === null) break;
        const isAgentOwnerFee = event.fields.is_agent_owner_fee === true;

        const bucket = accrualsByClaim.get(claimId) ?? [];
        bucket.push({ amount, isAgentOwnerFee });
        accrualsByClaim.set(claimId, bucket);

        await insertFeeAccrual({
          accrual_id: `${event.txHash}:${event.index}`,
          claim_id: claimId,
          recipient,
          source: isAgentOwnerFee ? "agent_owner" : "platform",
          amount_atomic: amount,
          transaction_hash: event.txHash,
          log_index: event.index,
          accrued_at: event.at,
        });
        result.accruals += 1;
        break;
      }

      case "challenger_paid": {
        // The pull half of settlement. `net` is what actually left the escrow to
        // the challenger; `fee` is already covered by its own `fee_accrued`.
        const claimId = asClaimId(event.topics[0]);
        const net = asBigInt(event.fields.net);
        if (claimId === null || net === null) break;
        pulledByClaim.set(claimId, (pulledByClaim.get(claimId) ?? 0n) + net);
        result.payouts += 1;
        break;
      }

      case "fee_claimed": {
        const recipient = typeof event.topics[0] === "string" ? event.topics[0] : "";
        const amount = asBigInt(event.fields.amount);
        if (amount === null) break;
        await insertFeeClaim({
          claim_event_id: `${event.txHash}:${event.index}`,
          recipient,
          amount_atomic: amount,
          transaction_hash: event.txHash,
          log_index: event.index,
          claimed_at: event.at,
        });
        result.claims += 1;
        break;
      }

      case "market_settled": {
        const claimId = asClaimId(event.topics[0]);
        if (claimId === null) break;
        settlements.push({
          claimId,
          paid: asBigInt(event.fields.total_paid) ?? 0n,
          feesAtResolve: asBigInt(event.fields.total_fees) ?? 0n,
          owed: asBigInt(event.fields.owed_to_challengers) ?? 0n,
          dust: asBigInt(event.fields.dust) ?? 0n,
          txHash: event.txHash,
          settledAt: event.at,
        });
        break;
      }

      default:
        break;
    }
  }

  // Settlements are written last so every accrual and pull in this scan is already
  // grouped: the row is a snapshot of the market's totals as of `toLedger`, and a
  // later pass rewrites it (the upsert is keyed on claim_id) as more pulls land.
  for (const market of settlements) {
    const accruals = accrualsByClaim.get(market.claimId) ?? [];
    const { platformAtomic, agentOwnerAtomic } = splitFees(accruals);
    const pulled = pulledByClaim.get(market.claimId) ?? 0n;

    await upsertMarketSettlement({
      claim_id: market.claimId,
      gross_volume_atomic: grossVolume(market.paid, market.feesAtResolve, market.owed, market.dust),
      // What has actually reached a winner: pushed at resolve, plus every pull
      // observed so far. This grows between passes, by design.
      payout_atomic: market.paid + pulled,
      // The accrual ledger is authoritative for the split AND the total, because
      // fees taken at pull time never appear in the settlement event. Falling back
      // to the event's own figure keeps a market whose accruals aged out of the
      // RPC's retention window from reporting zero fees.
      platform_fee_atomic:
        platformAtomic === 0n && agentOwnerAtomic === 0n ? market.feesAtResolve : platformAtomic,
      agent_owner_fee_atomic: agentOwnerAtomic,
      dust_atomic: market.dust,
      transaction_hash: market.txHash,
      settled_at: market.settledAt,
    });
    result.settlements += 1;
  }

  // Advance only after the pass's writes land. A truncated scan still advances to
  // where it got to, so the next pass resumes rather than restarting.
  const reached = decoded.reduce((max, event) => Math.max(max, event.ledger), fromLedger);
  const nextCursor = scan.truncated ? reached : Math.max(reached, scan.latestLedger);
  if (nextCursor > fromLedger) await setSyncMeta(CURSOR_KEY, String(nextCursor));
  // Freshness for read-only portfolio performance. Advance it only when this pass
  // reached the RPC head. A truncated or failed pass leaves the previous value
  // intact so consumers cannot mistake a partial settlement projection for live data.
  if (!scan.truncated) {
    await setSyncMeta("settlement_last_sync_at", String(Date.now()));
  }

  return result;
}
