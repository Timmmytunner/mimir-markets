/**
 * Baskets over the agent directory.
 *
 * A basket is a weighted set of agents. Its curve is built from what its members
 * actually settled: each member's daily return is its realised P&L over what it
 * staked that day, and the basket's return is those weighted by allocation. That is
 * a virtual backtest of published results — no funds are pooled and nothing is
 * deposited, which is the boundary ADR-0008 draws until an audit says otherwise.
 *
 * Members may come from any track, so a basket can mix the council's twenty frames
 * with third-party BYOA agents.
 */

import "server-only";

import {
  dailyReturnPoints, DEFAULT_BASKET_POLICY, simulateVirtualBasket, validateBasket, VIRTUAL_BASKET_INITIAL_NAV_ATOMIC,
  type BasketAgentResult, type BasketAgentWeight, type BasketSnapshot,
} from "@/lib/baskets";
import {
  computeAgentPerformance, windowSinceMs,
  type AgentPerformance, type AgentTradeResult, type TimeWindow,
} from "@/lib/agents/performance";
import { getAgentTradeRows, listBaskets } from "@/lib/db";
import { listDirectoryAgents, type DirectoryAgent } from "./agent-directory";

/** Re-export so API routes keep importing from the server basket module. */
export { DEFAULT_BASKET_POLICY };

export interface BasketDefinition {
  id: string;
  name: string;
  emoji: string;
  thesis: string;
  /** Agent ids from the directory, with basis-point weights totalling 10000. */
  members: Array<{ agentId: string; weightBps: number }>;
  /** Set for user-composed baskets; curated ones have no creator to pay. */
  creatorWallet?: string;
  subscriberCount?: number;
  createdAt?: number;
}

/**
 * Curated baskets.
 *
 * Weights are round numbers on purpose: a virtual basket's job here is to show how
 * mixing frames changes the curve, and precision no evidence supports would only
 * dress that up as optimisation.
 */
export const BASKET_DEFINITIONS: readonly BasketDefinition[] = [
  {
    id: "council-core",
    name: "Council Core",
    emoji: "🏛️",
    thesis: "The four classic council frames, equally weighted. A baseline for what the house view returns.",
    members: [
      { agentId: "optimist", weightBps: 2_500 },
      { agentId: "pessimist", weightBps: 2_500 },
      { agentId: "contrarian", weightBps: 2_500 },
      { agentId: "statistician", weightBps: 2_500 },
    ],
  },
  {
    id: "philosopher-spread",
    name: "Philosopher Spread",
    emoji: "📜",
    thesis: "Frames that pull on different axes — scepticism, computation, uncertainty, incentives — so their errors are less likely to line up.",
    members: [
      { agentId: "socrates", weightBps: 2_000 },
      { agentId: "ada", weightBps: 2_000 },
      { agentId: "taleb", weightBps: 2_000 },
      { agentId: "kahneman", weightBps: 2_000 },
      { agentId: "machiavelli", weightBps: 2_000 },
    ],
  },
  {
    id: "byoa-traders",
    name: "BYOA Traders",
    emoji: "🤖",
    thesis: "The three third-party demo agents: momentum, contrarian and quantitative thresholds.",
    members: [
      { agentId: "momentum-forecaster", weightBps: 3_400 },
      { agentId: "contrarian-fader", weightBps: 3_300 },
      { agentId: "quant-thresholder", weightBps: 3_300 },
    ],
  },
  {
    id: "house-and-street",
    name: "House and Street",
    emoji: "🧮",
    thesis: "Mimir's own oracle beside independent agents — the house view against the street's.",
    members: [
      { agentId: "statistician", weightBps: 2_500 },
      { agentId: "whale-watcher", weightBps: 2_500 },
      { agentId: "momentum-forecaster", weightBps: 2_500 },
      { agentId: "quant-thresholder", weightBps: 2_500 },
    ],
  },
];

export interface BasketMemberView extends DirectoryAgent {
  weightBps: number;
  performance: AgentPerformance;
  /** This member's share of the basket's realised P&L, in atomic USDC. */
  contributionAtomic: bigint;
}

export interface BasketView {
  definition: BasketDefinition;
  members: BasketMemberView[];
  /** Ids named by the basket that the directory could not resolve. */
  missing: string[];
  snapshots: BasketSnapshot[];
  navAtomic: bigint;
  initialNavAtomic: bigint;
  /** NAV change over the window, in basis points. */
  returnBps: number;
  maxDrawdownBps: number;
  realisedPnlAtomic: bigint;
  openExposureAtomic: bigint;
  settled: number;
  wins: number;
  losses: number;
  winRateBps: number;
  policyErrors: string[];
}

export async function buildBasketView(
  definition: BasketDefinition, window: TimeWindow = "all", nowMs = Date.now(),
): Promise<BasketView> {
  const directory = await listDirectoryAgents();
  const byId = new Map(directory.map((agent) => [agent.id, agent]));
  const sinceMs = windowSinceMs(window, nowMs);

  const resolved = definition.members.filter((member) => byId.has(member.agentId));
  const missing = definition.members
    .filter((member) => !byId.has(member.agentId))
    .map((member) => member.agentId);

  const rows = await Promise.all(
    resolved.map((member) => getAgentTradeRows(byId.get(member.agentId)!.address).catch(() => [])),
  );

  const settledResults: BasketAgentResult[] = [];
  const members: BasketMemberView[] = [];
  let realisedPnlAtomic = 0n;
  let openExposureAtomic = 0n;
  let settled = 0, wins = 0, losses = 0;

  resolved.forEach((member, index) => {
    const agent = byId.get(member.agentId)!;
    const { performance, results } = computeAgentPerformance(rows[index], { sinceMs });
    for (const result of results) {
      if (result.outcome === "open") continue;
      if (result.settledAt < (sinceMs ?? 0)) continue;
      settledResults.push({
        agentId: member.agentId, settledAt: result.settledAt,
        pnlAtomic: result.pnlAtomic, stakeAtomic: result.stakeAtomic,
      });
    }

    // Contribution is the member's realised P&L scaled by its allocation: what this
    // agent did to the basket, not what it did on its own book.
    const contributionAtomic = (performance.realisedPnlAtomic * BigInt(member.weightBps)) / 10_000n;
    realisedPnlAtomic += contributionAtomic;
    openExposureAtomic += (performance.openExposureAtomic * BigInt(member.weightBps)) / 10_000n;
    settled += performance.settled;
    wins += performance.wins;
    losses += performance.losses;

    members.push({ ...agent, weightBps: member.weightBps, performance, contributionAtomic });
  });

  const weights: BasketAgentWeight[] = members.map((member) => ({
    agentId: member.id,
    weightBps: member.weightBps,
    category: member.track,
    mode: "pool",
  }));

  const snapshots = simulateVirtualBasket(weights, dailyReturnPoints(settledResults));
  const navAtomic = snapshots.at(-1)?.navAtomic ?? VIRTUAL_BASKET_INITIAL_NAV_ATOMIC;
  const decided = wins + losses;

  return {
    definition, members, missing, snapshots,
    navAtomic,
    initialNavAtomic: VIRTUAL_BASKET_INITIAL_NAV_ATOMIC,
    returnBps: Number(((navAtomic - VIRTUAL_BASKET_INITIAL_NAV_ATOMIC) * 10_000n) / VIRTUAL_BASKET_INITIAL_NAV_ATOMIC),
    maxDrawdownBps: snapshots.reduce((worst, snapshot) => Math.max(worst, snapshot.drawdownBps), 0),
    realisedPnlAtomic, openExposureAtomic, settled, wins, losses,
    winRateBps: decided > 0 ? Math.round((wins / decided) * 10_000) : 0,
    // Reported rather than thrown: a curated basket that breaches a policy should be
    // visible as such, not a page that fails to render.
    policyErrors: validateBasket(weights, DEFAULT_BASKET_POLICY),
  };
}

/**
 * Curated baskets plus everything users have composed.
 *
 * Stored baskets are read through the same view builder, so a user's basket gets
 * the same curve, contribution split and policy check as a curated one — there is
 * no second, weaker code path for the ones that matter to somebody.
 */
export async function allBasketDefinitions(): Promise<BasketDefinition[]> {
  const stored = await listBaskets().catch(() => []);
  const userDefined = stored.map((basket): BasketDefinition => {
    let members: Array<{ agentId: string; weightBps: number }> = [];
    try {
      members = JSON.parse(basket.membersJson);
    } catch {
      members = [];
    }
    return {
      id: basket.basketId,
      name: basket.name,
      emoji: "🧺",
      thesis: basket.thesis || "Composed by a Mimir user.",
      members,
      creatorWallet: basket.creatorWallet,
      subscriberCount: basket.subscriberCount ?? 0,
      createdAt: basket.createdAt,
    };
  });
  return [...BASKET_DEFINITIONS, ...userDefined];
}

export async function listBasketViews(window: TimeWindow = "all", nowMs = Date.now()): Promise<BasketView[]> {
  const definitions = await allBasketDefinitions();
  return Promise.all(definitions.map((definition) => buildBasketView(definition, window, nowMs)));
}

export function findBasketDefinition(id: string): BasketDefinition | null {
  return BASKET_DEFINITIONS.find((definition) => definition.id === id) ?? null;
}

export async function findAnyBasketDefinition(id: string): Promise<BasketDefinition | null> {
  return (await allBasketDefinitions()).find((definition) => definition.id === id) ?? null;
}
