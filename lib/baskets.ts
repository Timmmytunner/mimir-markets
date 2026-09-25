/**
 * What the creator signs when composing a basket. Readable, because a hardware
 * wallet shows it verbatim.
 *
 * The address is interpolated verbatim: a Stellar strkey is case-sensitive
 * base32, so any toLowerCase() on it would produce a string no wallet ever signed.
 */
export function basketMessage(args: {
  name: string; creator: string; members: Array<{ agentId: string; weightBps: number }>;
}): string {
  return [
    "Mimir basket",
    `name: ${args.name}`,
    `creator: ${args.creator}`,
    `members: ${args.members.map((m) => `${m.agentId}:${m.weightBps}`).join(",")}`,
  ].join("\n");
}

/**
 * How long a transfer authorisation is valid from the moment it is signed.
 *
 * Five minutes matches the agent-request clock-skew window
 * (`AGENT_REQUEST_MAX_SKEW_MS` in lib/agents/api.ts). A signer generates the
 * message, signs it in their wallet, and submits — that round-trip is well
 * inside five minutes. Any captured signature is useless after the window.
 */
export const TRANSFER_EXPIRY_MS = 5 * 60_000; // 5 minutes

/**
 * What the CURRENT owner signs to authorise a transfer.
 *
 * Both addresses are interpolated verbatim — Stellar strkeys are case-sensitive
 * base32 and must never be lowercased. The message now also includes:
 *
 *  - `nonce`     — a client-generated UUID, stored on the server after first use
 *                  so the same signed message is rejected on any replay attempt.
 *  - `expiresAt` — an ISO-8601 timestamp; the server rejects the message if the
 *                  current time is past this value. Limits the replay window even
 *                  before the nonce has been persisted (e.g. during a DB outage).
 *
 * Together these two fields mean:
 *   - A signature captured in transit cannot be replayed after TRANSFER_EXPIRY_MS.
 *   - Even within the window, submitting the same signed payload twice is rejected
 *     by the UNIQUE(nonce) constraint on basket_ownership_transfers.
 *   - If ownership cycles A→B→A, the old A→B signature is still unusable because
 *     its nonce was consumed on first use.
 */
export function transferMessage(args: {
  basketId: string;
  currentOwner: string;
  newOwner: string;
  nonce: string;
  expiresAt: number;
}): string {
  return [
    "Mimir basket transfer",
    `basket: ${args.basketId}`,
    `from: ${args.currentOwner}`,
    `to: ${args.newOwner}`,
    `nonce: ${args.nonce}`,
    `expiresAt: ${new Date(args.expiresAt).toISOString()}`,
  ].join("\n");
}

/**
 * The ids of curated baskets that ship with Mimir.
 *
 * Kept here (the pure computation module, no server-only dependency) so that
 * tests and non-server code can verify the curated-basket guard without pulling
 * in lib/server/basket-directory which carries `import "server-only"`.
 *
 * This list must stay in sync with BASKET_DEFINITIONS in
 * lib/server/basket-directory.ts — a schema-backlog-style test in
 * tests/node/basket-ownership.test.ts pins the correspondence.
 */
export const CURATED_BASKET_IDS: readonly string[] = [
  "council-core",
  "philosopher-spread",
  "byoa-traders",
  "house-and-street",
];

export interface BasketAgentWeight {
  agentId: string;
  weightBps: number;
  category: string;
  mode: string;
  paused?: boolean;
  stale?: boolean;
}
export interface BasketReturnPoint { timestamp: number; returnsBps: Record<string, number> }
export interface BasketPolicy { maxSingleAgentBps: number; maxCategoryBps: number; staleSignalAction: "skip" | "pause"; failedCopyAction: "keep_idle" | "pause" }
export interface BasketSnapshot { timestamp: number; navAtomic: bigint; drawdownBps: number }

export const VIRTUAL_BASKET_INITIAL_NAV_ATOMIC = 1_000_000_000n;

/**
 * Default create/follow policy: no agent over 40%, no category (track) over 60%.
 * Kept in the shared lib so the create UI preview matches the API gate exactly.
 */
export const DEFAULT_BASKET_POLICY: BasketPolicy = {
  maxSingleAgentBps: 4_000,
  maxCategoryBps: 6_000,
  staleSignalAction: "skip",
  failedCopyAction: "keep_idle",
};

export type BasketExposurePreviewStatus = "empty" | "incomplete" | "invalid" | "ready";

export interface BasketExposureBar {
  key: string;
  bps: number;
  /** True when this bar alone breaches the matching policy cap. */
  overLimit: boolean;
}

/**
 * Live exposure snapshot for the basket create form — same math as `basketExposure`
 * + `validateBasket`, with UI-ready bars and a discrete status.
 *
 * Does not touch wallets, deposits, or analytics; pure allocation arithmetic.
 */
export interface BasketExposurePreview {
  status: BasketExposurePreviewStatus;
  totalBps: number;
  categories: Record<string, number>;
  modes: Record<string, number>;
  categoryBars: BasketExposureBar[];
  modeBars: BasketExposureBar[];
  agentBars: BasketExposureBar[];
  errors: string[];
  policy: BasketPolicy;
}

export function validateBasket(weights: BasketAgentWeight[], policy: BasketPolicy): string[] {
  const errors: string[] = [];
  if (weights.reduce((sum, item) => sum + item.weightBps, 0) !== 10_000) errors.push("weights_must_total_10000_bps");
  if (new Set(weights.map((item) => item.agentId)).size !== weights.length) errors.push("duplicate_agent");
  if (weights.some((item) => item.weightBps <= 0 || item.weightBps > policy.maxSingleAgentBps)) errors.push("single_agent_exposure");
  const categories = new Map<string, number>();
  for (const item of weights) categories.set(item.category, (categories.get(item.category) ?? 0) + item.weightBps);
  if ([...categories.values()].some((value) => value > policy.maxCategoryBps)) errors.push("category_exposure");
  return errors;
}

/** Read-only backtest. Missing, paused and stale signals remain idle USDC (0% return). */
export function simulateVirtualBasket(weights: BasketAgentWeight[], points: BasketReturnPoint[], initialNavAtomic = VIRTUAL_BASKET_INITIAL_NAV_ATOMIC): BasketSnapshot[] {
  let nav = initialNavAtomic;
  let high = nav;
  return [...points].sort((a, b) => a.timestamp - b.timestamp).map((point) => {
    let weightedReturn = 0n;
    for (const agent of weights) {
      if (agent.paused || agent.stale) continue;
      weightedReturn += BigInt(point.returnsBps[agent.agentId] ?? 0) * BigInt(agent.weightBps);
    }
    nav = nav + (nav * weightedReturn) / 100_000_000n;
    if (nav > high) high = nav;
    const drawdownBps = high === 0n ? 0 : Number(((high - nav) * 10_000n) / high);
    return { timestamp: point.timestamp, navAtomic: nav, drawdownBps };
  });
}

export function basketExposure(weights: BasketAgentWeight[]) {
  const categories: Record<string, number> = {};
  const modes: Record<string, number> = {};
  for (const item of weights) {
    categories[item.category] = (categories[item.category] ?? 0) + item.weightBps;
    modes[item.mode] = (modes[item.mode] ?? 0) + item.weightBps;
  }
  return { categories, modes };
}

function barsFromRecord(
  record: Record<string, number>,
  limitBps: number | null,
): BasketExposureBar[] {
  return Object.entries(record)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([key, bps]) => ({
      key,
      bps,
      overLimit: limitBps !== null && bps > limitBps,
    }));
}

/**
 * Preview category / mode / agent concentration before a basket is created.
 *
 * - empty: no positive weights
 * - incomplete: weights present but do not total 10_000 bps (still shows bars)
 * - invalid: totals 10_000 but fails policy (or has duplicates / non-positive)
 * - ready: passes `validateBasket`
 */
export function previewBasketExposureBeforeCreate(
  weights: BasketAgentWeight[],
  policy: BasketPolicy = DEFAULT_BASKET_POLICY,
): BasketExposurePreview {
  const active = weights.filter((item) => item.weightBps > 0);
  const exposure = basketExposure(active);
  const totalBps = active.reduce((sum, item) => sum + item.weightBps, 0);
  const errors = active.length === 0 ? [] : validateBasket(active, policy);

  let status: BasketExposurePreviewStatus;
  if (active.length === 0) status = "empty";
  else if (totalBps !== 10_000) status = "incomplete";
  else if (errors.length > 0) status = "invalid";
  else status = "ready";

  const agentRecord: Record<string, number> = {};
  for (const item of active) {
    agentRecord[item.agentId] = (agentRecord[item.agentId] ?? 0) + item.weightBps;
  }

  return {
    status,
    totalBps,
    categories: exposure.categories,
    modes: exposure.modes,
    categoryBars: barsFromRecord(exposure.categories, policy.maxCategoryBps),
    modeBars: barsFromRecord(exposure.modes, null),
    agentBars: barsFromRecord(agentRecord, policy.maxSingleAgentBps),
    errors,
    policy,
  };
}


/** Performance fee applies only to realized NAV above the previous high-water mark. */
export function highWaterMarkFee(navAtomic: bigint, highWaterMarkAtomic: bigint, performanceFeeBps: bigint) {
  if (performanceFeeBps < 0n || performanceFeeBps > 1_000n) throw new Error("performance fee cap");
  const gain = navAtomic > highWaterMarkAtomic ? navAtomic - highWaterMarkAtomic : 0n;
  const feeAtomic = (gain * performanceFeeBps) / 10_000n;
  return { feeAtomic, nextHighWaterMarkAtomic: navAtomic > highWaterMarkAtomic ? navAtomic : highWaterMarkAtomic };
}

export function sharesForDeposit(assetsAtomic: bigint, totalAssetsAtomic: bigint, totalSharesAtomic: bigint): bigint {
  if (assetsAtomic <= 0n) throw new Error("zero deposit");
  if (totalSharesAtomic === 0n) return assetsAtomic;
  if (totalAssetsAtomic <= 0n) throw new Error("invalid insolvent vault");
  return (assetsAtomic * totalSharesAtomic) / totalAssetsAtomic;
}

export function assetsForRedemption(sharesAtomic: bigint, totalAssetsAtomic: bigint, totalSharesAtomic: bigint): bigint {
  if (sharesAtomic <= 0n || totalSharesAtomic <= 0n) throw new Error("invalid redemption");
  return (sharesAtomic * totalAssetsAtomic) / totalSharesAtomic;
}

const DAY_MS = 86_400_000;

/** One agent's settled result, as the basket engine needs to see it. */
export interface BasketAgentResult {
  agentId: string;
  /** Milliseconds. */
  settledAt: number;
  pnlAtomic: bigint;
  stakeAtomic: bigint;
}

/**
 * Daily return per agent, in basis points of what that agent staked that day.
 *
 * Weighted by stake rather than counting trades: a 10 USDC decision and a 1 USDC one
 * are not two equal votes, and averaging them as if they were flatters whoever bets
 * small and often.
 *
 * Days with no settlement produce no point at all, so an idle agent contributes a
 * flat line rather than a zero that drags the basket's average down.
 */
export function dailyReturnPoints(results: readonly BasketAgentResult[]): BasketReturnPoint[] {
  const byDay = new Map<number, Map<string, { pnl: bigint; stake: bigint }>>();

  for (const result of results) {
    if (result.stakeAtomic <= 0n) continue;
    const day = Math.floor(result.settledAt / DAY_MS) * DAY_MS;
    const agents = byDay.get(day) ?? new Map<string, { pnl: bigint; stake: bigint }>();
    const running = agents.get(result.agentId) ?? { pnl: 0n, stake: 0n };
    agents.set(result.agentId, {
      pnl: running.pnl + result.pnlAtomic,
      stake: running.stake + result.stakeAtomic,
    });
    byDay.set(day, agents);
  }

  return [...byDay.entries()]
    .sort(([a], [b]) => a - b)
    .map(([timestamp, agents]) => {
      const returnsBps: Record<string, number> = {};
      for (const [agentId, { pnl, stake }] of agents) {
        returnsBps[agentId] = stake === 0n ? 0 : Number((pnl * 10_000n) / stake);
      }
      return { timestamp, returnsBps };
    });
}
