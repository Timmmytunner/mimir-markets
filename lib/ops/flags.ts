/**
 * Feature flags and incident kill switches.
 *
 * The requirement that shapes this: during an incident, create / stake / copy /
 * x402 must be pausable **independently**. A single global "maintenance mode" is
 * useless in practice — if Horizon is unreachable and payment proofs cannot be
 * verified you want to stop selling paid endpoints while people can still settle
 * and withdraw, and if a pricing bug is found you want to stop new stakes without
 * freezing payouts.
 *
 * Two rules:
 *
 *  1. **Withdrawal is never pausable.** Users must always be able to pull a parked
 *     payout, even mid-incident. There is deliberately no switch for it — an
 *     operator cannot accidentally trap funds.
 *  2. **Read paths stay up.** Pausing writes must not blank the explorer, because a
 *     status page nobody can reach is not a status page.
 *
 * Env-driven so a switch can be flipped without a deploy.
 */

/** Capabilities that can be paused independently during an incident. */
export const PAUSABLE = [
  "create_market",
  "stake",
  "copy_execution",
  "x402_selling",
  "x402_buying",
  "agent_registration",
  "market_creator_worker",
  "council_worker",
  "oracle_settlement",
  // Outbound source fetches through `lib/research/gateway.ts`. Listed here rather
  // than read ad hoc so `MIMIR_PAUSE_ALL` reaches it like every other switch.
  "research",
] as const;
export type Pausable = (typeof PAUSABLE)[number];

export function isPausable(value: string): value is Pausable {
  return (PAUSABLE as readonly string[]).includes(value);
}

/**
 * Things that must never be switchable, kept explicit so the invariant is
 * documented in code rather than remembered.
 */
export const NEVER_PAUSABLE = ["withdraw", "read_markets", "read_reasoning"] as const;
export type NeverPausable = (typeof NEVER_PAUSABLE)[number];

export function isNeverPausable(value: string): value is NeverPausable {
  return (NEVER_PAUSABLE as readonly string[]).includes(value);
}

/** MIMIR_PAUSE_STAKE=1 pauses staking. */
export function pauseEnvKey(capability: Pausable): string {
  return `MIMIR_PAUSE_${capability.toUpperCase()}`;
}

export interface PauseState {
  paused: boolean;
  /** Operator-supplied reason, surfaced to users so a block is explainable. */
  reason?: string;
  /** True when everything was paused at once. */
  viaGlobal: boolean;
}

/**
 * The canonical per-capability pause detail returned on any blocked write.
 *
 * Structured so an autonomous agent can branch on `capability` and `viaGlobal`
 * without parsing a human-readable string. `pausedAt` is epoch ms derived from
 * `MIMIR_PAUSE_<CAP>_AT` (or `MIMIR_PAUSE_ALL_AT` for the global switch); absent
 * when the env var was not set — which is fine: the important fields are
 * `capability` and `reason`.
 *
 * Exposed on every 503 / 403 that a pause produces so callers never have to
 * infer these fields from a prose message.
 */
export interface CapabilityPauseDetail {
  capability: Pausable;
  reason: string;
  viaGlobal: boolean;
  /** Epoch ms when this capability was paused, when the operator set the timestamp. */
  pausedAt?: number;
}

/** Build a `CapabilityPauseDetail` from the current pause state. */
export function buildPauseDetail(
  capability: Pausable,
  state: PauseState,
  env: Record<string, string | undefined> = process.env,
): CapabilityPauseDetail {
  const reason =
    state.reason ??
    `${capability.replace(/_/g, " ")} is temporarily paused${state.viaGlobal ? " (all writes)" : ""}`;

  const rawAt = state.viaGlobal
    ? env.MIMIR_PAUSE_ALL_AT
    : env[`${pauseEnvKey(capability)}_AT`];
  const pausedAt =
    rawAt !== undefined && /^\d+$/.test(rawAt.trim())
      ? parseInt(rawAt.trim(), 10)
      : undefined;

  return { capability, reason, viaGlobal: state.viaGlobal, ...(pausedAt !== undefined ? { pausedAt } : {}) };
}

/**
 * Is this capability paused?
 *
 * `MIMIR_PAUSE_ALL` exists for the one case where an operator genuinely wants
 * everything down, but it still cannot touch the never-pausable list.
 */
export function pauseState(
  capability: Pausable,
  env: Record<string, string | undefined> = process.env,
): PauseState {
  const specific = env[pauseEnvKey(capability)] === "1";
  if (specific) {
    return {
      paused: true,
      reason: env[`${pauseEnvKey(capability)}_REASON`] ?? env.MIMIR_PAUSE_REASON,
      viaGlobal: false,
    };
  }
  if (env.MIMIR_PAUSE_ALL === "1") {
    return { paused: true, reason: env.MIMIR_PAUSE_REASON, viaGlobal: true };
  }
  return { paused: false, viaGlobal: false };
}

export function isPaused(
  capability: Pausable,
  env: Record<string, string | undefined> = process.env,
): boolean {
  return pauseState(capability, env).paused;
}

/** Everything currently paused, for a status endpoint and the ops dashboard. */
export function pausedCapabilities(
  env: Record<string, string | undefined> = process.env,
): Pausable[] {
  return PAUSABLE.filter((capability) => isPaused(capability, env));
}

// ── Feature flags ─────────────────────────────────────────────────────────────

/**
 * Rollout flags, distinct from pause switches: a flag gates something not yet
 * finished, a pause stops something that works but must stop NOW. Conflating them
 * means an incident pause looks like an unfinished feature in the logs.
 */
export const FEATURES = [
  "duel_mode",
  "fixed_odds",
  "underdog_discovery",
  "rematch_ladder",
  "streak_scoring",
  "conviction_scoring",
  "reasoning_feed",
  "share_cards",
  "byoa_registry",
  "byoa_funded_actions",
  "copy_trading",
  "virtual_baskets",
  "agent_baskets",
  "fee_policy",
  // Durable nonce persistence with per-row TTL expiry. ON by default — this is a
  // security property (replay protection), not a product feature. The flag exists
  // so an operator can see it in the feature list and confirm it is always on.
  // Turning it OFF (MIMIR_FEATURE_NONCE_PERSISTENCE=0) reverts to the pre-migration
  // in-process-only nonce store, which loses replay protection on restart and across
  // instances. Only disable in an isolated local dev environment.
  "nonce_persistence",
] as const;
export type Feature = (typeof FEATURES)[number];

export function isFeature(value: string): value is Feature {
  return (FEATURES as readonly string[]).includes(value);
}

/**
 * Default state per feature. Anything that can move a user's money without an
 * explicit per-action signature defaults OFF, and stays off until its own gate in
 * the roadmap is met — a flag is not a substitute for that review.
 */
const FEATURE_DEFAULTS: Record<Feature, boolean> = {
  duel_mode: true,
  fixed_odds: true,
  underdog_discovery: true,
  rematch_ladder: true,
  streak_scoring: true,
  conviction_scoring: true,
  reasoning_feed: true,
  share_cards: true,
  // Registration is read-only in effect; funded actions are not.
  byoa_registry: true,
  byoa_funded_actions: false,
  copy_trading: false,
  virtual_baskets: true,
  agent_baskets: false,
  // The fee policy lives in `contracts-soroban/mimir-market`, which has no
  // independent audit yet (see docs/LAUNCH_GATE_STATUS.md). Turning this on before
  // that gate closes would charge fees against an escrow nobody has reviewed.
  fee_policy: false,
  // Nonce persistence is a security invariant, not a product rollout. Default ON
  // so no deploy step is needed; only disable in isolated local dev.
  nonce_persistence: true,
};

function featureEnvKey(feature: Feature): string {
  return `MIMIR_FEATURE_${feature.toUpperCase()}`;
}

export function isFeatureEnabled(
  feature: Feature,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = env[featureEnvKey(feature)];
  if (raw === "1") return true;
  if (raw === "0") return false;
  return FEATURE_DEFAULTS[feature];
}

/** Features that are off by default because they need a review gate first. */
export function gatedFeatures(): Feature[] {
  return FEATURES.filter((feature) => !FEATURE_DEFAULTS[feature]);
}

// ── Per-category kill switch ──────────────────────────────────────────────────

/**
 * Stop creating markets in one category without a deploy.
 *
 * Distinct from the compliance gate in `lib/research/categories.ts`, which decides
 * whether a category is ever permissible. This is the operational case: a category
 * that is allowed in principle is producing bad settlements right now and should
 * stop until someone looks at it.
 *
 * Disable-list rather than an allow-list on purpose — an allow-list that has to be
 * kept in sync with the category registry silently drops a new category the day it
 * ships.
 */
export function isCategoryEnabled(
  categoryId: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const id = categoryId.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  if (id.length === 0) return false;
  return env[`MIMIR_DISABLE_CATEGORY_${id}`] !== "1";
}

/** Categories an operator has switched off, for a status endpoint. */
export function disabledCategories(
  categoryIds: readonly string[],
  env: Record<string, string | undefined> = process.env,
): string[] {
  return categoryIds.filter((id) => !isCategoryEnabled(id, env));
}

// ── The single gate a write path calls ────────────────────────────────────────

export type WriteBlockReason = "feature_disabled" | "category_disabled" | "paused";

export interface WriteGateResult {
  allowed: boolean;
  reason?: WriteBlockReason;
  /** Human-readable, shown to the user so a block is explainable. */
  detail?: string;
  /**
   * Present exactly when `reason === "paused"`. Carries the structured
   * per-capability detail an autonomous agent can act on without parsing prose.
   */
  pauseDetail?: CapabilityPauseDetail;
}

/**
 * Check a write is permitted: its feature is on AND its capability is not paused.
 *
 * Feature first: "this is not available yet" is a truer message than "temporarily
 * paused" for something that was never enabled.
 */
export function checkWriteAllowed(
  args: { feature?: Feature; capability: Pausable; category?: string },
  env: Record<string, string | undefined> = process.env,
): WriteGateResult {
  if (args.feature && !isFeatureEnabled(args.feature, env)) {
    return {
      allowed: false,
      reason: "feature_disabled",
      detail: `${args.feature.replace(/_/g, " ")} is not enabled`,
    };
  }
  if (args.category && !isCategoryEnabled(args.category, env)) {
    return {
      allowed: false,
      reason: "category_disabled",
      detail: `${args.category} markets are temporarily disabled`,
    };
  }
  const pause = pauseState(args.capability, env);
  if (pause.paused) {
    const pauseDetail = buildPauseDetail(args.capability, pause, env);
    return {
      allowed: false,
      reason: "paused",
      detail: pauseDetail.reason,
      pauseDetail,
    };
  }
  return { allowed: true };
}
