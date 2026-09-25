import assert from "node:assert/strict";
import test from "node:test";

import {
  AGENT_CAPABILITIES,
  AUTHORITY_LEVELS,
  CHALLENGE_TTL_MS,
  REGISTRY_SCHEMA_VERSION,
  authorizeAction,
  buildChallengeMessage,
  defaultLimits,
  evaluateRegistrationReplay,
  grantCapability,
  isAgentCapability,
  metadataHash,
  revokeAgent,
  rotateOperator,
  verifyChallenge,
  type AgentRecord,
  type RegistrationChallenge,
} from "../../lib/agents/registry";

// Real, valid `G…` strkeys. Fixed literals rather than `Keypair.random()` so a
// failure is reproducible, and deliberately NOT lowercased anywhere below: a
// strkey is case-sensitive base32, which is the property these tests now pin.
const OWNER = "GBMGZBFKUNOS7JWPRPF5IMZR27DCR6BEP6SQVFV2I354UPY35FZTIR2Y";
const OPERATOR = "GDZCBCIU6EI5FM5UC5IAWRT5ZY76OK4QDX5BEELC5V3NTNGAUIX5X4UH";
const STRANGER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const NETWORK = "Test SDF Network ; September 2015";
const OTHER_NETWORK = "Public Global Stellar Network ; September 2015";
const NOW = 1_780_000_000_000;

function agent(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    agentId: "acme-forecaster",
    ownerWallet: OWNER,
    operatorWallet: OPERATOR,
    payoutWallet: OWNER,
    displayName: "Acme Forecaster",
    description: "Sports and macro claims.",
    capabilities: ["researcher", "market_creator"],
    authorityLevel: AUTHORITY_LEVELS.CREATE,
    limits: { ...defaultLimits(), maxPositionUsdc: 5, maxDailyExposureUsdc: 20, maxActiveMarkets: 3 },
    status: "active",
    reputationBps: 6_000,
    createdAt: NOW - 1_000,
    updatedAt: NOW - 1_000,
    ...overrides,
  };
}

function challenge(overrides: Partial<RegistrationChallenge> = {}): RegistrationChallenge {
  return {
    agentId: "acme-forecaster",
    wallet: OPERATOR,
    nonce: "n-1",
    network: NETWORK,
    issuedAt: NOW,
    expiresAt: NOW + CHALLENGE_TTL_MS,
    role: "operator",
    ...overrides,
  };
}

// ── The challenge: proving control without handing over a key ──────────────────

test("the signed message is domain-bound, nonce'd and expiring", () => {
  const message = buildChallengeMessage(challenge());
  assert.match(message, /Mimir agent registration/);
  assert.match(message, /network: Test SDF Network ; September 2015/);
  // The wallet is named verbatim — folding its case would make the message
  // describe an address that does not exist.
  assert.ok(message.includes(`wallet: ${OPERATOR}`));
  assert.match(message, /nonce: n-1/);
  assert.match(message, /expiresAt: /);
  // The signer may be a hardware wallet; the owner must be able to read that
  // this does not move funds.
  assert.match(message, /does not move funds/);
});

test("a valid fresh challenge is accepted", () => {
  const verdict = verifyChallenge({
    challenge: challenge(),
    signedWallet: OPERATOR,
    expectedNetwork: NETWORK,
    usedNonces: new Set(),
    now: NOW + 1_000,
  });
  assert.equal(verdict.ok, true);
});

test("wallet comparison is case-SENSITIVE, and whitespace-tolerant", () => {
  // The inverse of the EVM assertion this replaces. A Stellar strkey is
  // case-sensitive base32: a lowercased address is a DIFFERENT (invalid) string,
  // so accepting it would let a typo authorise as the real wallet.
  const folded = verifyChallenge({
    challenge: challenge({ wallet: OPERATOR.toLowerCase() }),
    signedWallet: OPERATOR,
    expectedNetwork: NETWORK,
    usedNonces: new Set(),
    now: NOW,
  });
  assert.equal(folded.ok, false);
  assert.equal(folded.reason, "wrong_wallet");

  // Whitespace is normalised though — an address pasted from a .env can arrive
  // padded, and that is not a different wallet.
  const padded = verifyChallenge({
    challenge: challenge({ wallet: `  ${OPERATOR}  ` }),
    signedWallet: OPERATOR,
    expectedNetwork: NETWORK,
    usedNonces: new Set(),
    now: NOW,
  });
  assert.equal(padded.ok, true);
});

test("a replayed nonce is refused", () => {
  const verdict = verifyChallenge({
    challenge: challenge(),
    signedWallet: OPERATOR,
    expectedNetwork: NETWORK,
    usedNonces: new Set(["n-1"]),
    now: NOW,
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "nonce_reused");
});

test("an expired challenge is refused", () => {
  const verdict = verifyChallenge({
    challenge: challenge(),
    signedWallet: OPERATOR,
    expectedNetwork: NETWORK,
    usedNonces: new Set(),
    now: NOW + CHALLENGE_TTL_MS + 1,
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "expired");
});

test("a challenge for another network is refused", () => {
  // Otherwise a Pubnet signature would register a Testnet agent.
  const verdict = verifyChallenge({
    challenge: challenge({ network: OTHER_NETWORK }),
    signedWallet: OPERATOR,
    expectedNetwork: NETWORK,
    usedNonces: new Set(),
    now: NOW,
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "wrong_network");
});

test("a signature from a different wallet is refused", () => {
  const verdict = verifyChallenge({
    challenge: challenge(),
    signedWallet: STRANGER,
    expectedNetwork: NETWORK,
    usedNonces: new Set(),
    now: NOW,
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "wrong_wallet");
});

test("a challenge issued in the future is refused", () => {
  const verdict = verifyChallenge({
    challenge: challenge({ issuedAt: NOW + 10 * 60_000, expiresAt: NOW + 20 * 60_000 }),
    signedWallet: OPERATOR,
    expectedNetwork: NETWORK,
    usedNonces: new Set(),
    now: NOW,
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "not_yet_valid");
});

test("a malformed challenge is refused", () => {
  for (const bad of [{ nonce: "" }, { wallet: "" }, { agentId: "" }]) {
    const verdict = verifyChallenge({
      challenge: challenge(bad),
      signedWallet: OPERATOR,
      expectedNetwork: NETWORK,
      usedNonces: new Set(),
      now: NOW,
    });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, "malformed");
  }
});

// ── Capability gating ─────────────────────────────────────────────────────────

test("a granted capability within limits is allowed", () => {
  const verdict = authorizeAction(agent(), {
    capability: "market_creator",
    positionUsdc: 2,
    activeMarkets: 1,
  });
  assert.equal(verdict.allowed, true);
});

test("an ungranted capability is refused even at a high authority level", () => {
  // Level and capability are independent grants; neither implies the other.
  const verdict = authorizeAction(
    agent({ authorityLevel: AUTHORITY_LEVELS.MONETISE, capabilities: ["researcher"] }),
    { capability: "council_juror", positionUsdc: 1 },
  );
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.reason, "missing_capability");
});

test("a granted capability the authority level cannot exercise is refused", () => {
  const verdict = authorizeAction(
    agent({ authorityLevel: AUTHORITY_LEVELS.PROPOSE, capabilities: ["market_creator"] }),
    { capability: "market_creator" },
  );
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.reason, "insufficient_authority");
});

test("reputation alone grants nothing", () => {
  // A well-behaved agent must not accumulate its way into permissions.
  const verdict = authorizeAction(
    agent({ reputationBps: 10_000, capabilities: [], authorityLevel: AUTHORITY_LEVELS.MONETISE }),
    { capability: "copy_source" },
  );
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.reason, "missing_capability");
});

// ── Status precedence ─────────────────────────────────────────────────────────

test("a revoked agent is refused before any limit is even considered", () => {
  // "position too large" on a revoked agent would imply a smaller one works.
  const verdict = authorizeAction(
    agent({ status: "revoked", revokedReason: "operator key leaked" }),
    { capability: "market_creator", positionUsdc: 1_000_000 },
  );
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.reason, "revoked");
  assert.match(verdict.detail ?? "", /operator key leaked/);
});

test("paused and pending agents are refused distinctly", () => {
  assert.equal(
    authorizeAction(agent({ status: "paused" }), { capability: "market_creator" }).reason,
    "paused",
  );
  assert.equal(
    authorizeAction(agent({ status: "pending" }), { capability: "market_creator" }).reason,
    "pending",
  );
});

test("platform emergency pause wins over every agent-local permission", () => {
  const verdict = authorizeAction(agent(), {
    capability: "market_creator",
    platformPaused: true,
  });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.reason, "platform_paused");
});

// ── Limits ────────────────────────────────────────────────────────────────────

test("a position above the per-position limit is refused", () => {
  const verdict = authorizeAction(agent(), { capability: "market_creator", positionUsdc: 6 });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.reason, "position_too_large");
});

test("daily exposure counts what is already at risk", () => {
  // 18 already risked plus 5 exceeds the 20 daily cap even though 5 is a legal
  // single position.
  const verdict = authorizeAction(agent(), {
    capability: "market_creator",
    positionUsdc: 5,
    exposureTodayUsdc: 18,
  });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.reason, "daily_exposure_exceeded");
});

test("exposure exactly at the cap is allowed", () => {
  assert.equal(
    authorizeAction(agent(), {
      capability: "market_creator",
      positionUsdc: 5,
      exposureTodayUsdc: 15,
    }).allowed,
    true,
  );
});

test("the active-market cap applies to market creation", () => {
  const verdict = authorizeAction(agent(), { capability: "market_creator", activeMarkets: 3 });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.reason, "too_many_active_markets");
});

test("the rolling request limit is enforced at every authority level", () => {
  const record = agent({ authorityLevel: AUTHORITY_LEVELS.MONETISE });
  const verdict = authorizeAction(record, {
    capability: "market_creator",
    requestsThisHour: record.limits.maxRequestsPerHour,
  });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.reason, "rate_limit_exceeded");
});

test("category and mode allowlists are enforced when set, ignored when empty", () => {
  const scoped = agent({
    limits: { ...defaultLimits(), allowedCategories: ["sports"], allowedSettlementModes: ["duel"] },
  });
  assert.equal(
    authorizeAction(scoped, { capability: "market_creator", category: "crypto" }).reason,
    "category_not_allowed",
  );
  assert.equal(
    authorizeAction(scoped, { capability: "market_creator", category: "sports", settlementMode: "pool" })
      .reason,
    "mode_not_allowed",
  );
  assert.equal(
    authorizeAction(scoped, { capability: "market_creator", category: "sports", settlementMode: "duel" })
      .allowed,
    true,
  );
  // Empty lists mean "no restriction", not "nothing allowed".
  assert.equal(
    authorizeAction(agent(), { capability: "market_creator", category: "anything" }).allowed,
    true,
  );
});

// ── Owner / operator separation ───────────────────────────────────────────────

test("only the owner may rotate the operator key", () => {
  // Rotation is how a compromised hot key is recovered from, so an operator that
  // could rotate itself could lock the owner out.
  const byOperator = rotateOperator(agent(), { requestedBy: OPERATOR, newOperatorWallet: STRANGER });
  assert.equal(byOperator.ok, false);
  assert.equal(byOperator.ok === false && byOperator.reason, "not_owner");

  const byOwner = rotateOperator(agent(), { requestedBy: OWNER, newOperatorWallet: STRANGER, at: NOW });
  assert.equal(byOwner.ok, true);
  assert.equal(byOwner.ok && byOwner.agent.operatorWallet, STRANGER);
  // The owner and the fee destination are untouched by a rotation.
  assert.equal(byOwner.ok && byOwner.agent.ownerWallet, OWNER);
  assert.equal(byOwner.ok && byOwner.agent.payoutWallet, OWNER);
});

test("rotating to the same wallet is refused as a no-op", () => {
  const result = rotateOperator(agent(), { requestedBy: OWNER, newOperatorWallet: OPERATOR });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, "same_wallet");
});

test("a revoked agent cannot be rotated back into service", () => {
  const result = rotateOperator(agent({ status: "revoked" }), {
    requestedBy: OWNER,
    newOperatorWallet: STRANGER,
  });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, "revoked");
});

test("only the owner may revoke", () => {
  assert.equal(
    revokeAgent(agent(), { requestedBy: OPERATOR, reason: "x" }).ok,
    false,
  );
});

test("revocation clears capabilities, not just status", () => {
  // A stale in-memory copy that only checks capabilities must still refuse.
  const result = revokeAgent(agent(), { requestedBy: OWNER, reason: "key leaked", at: NOW });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.agent.capabilities, []);
  assert.equal(result.agent.authorityLevel, AUTHORITY_LEVELS.READ_ONLY);
  assert.equal(result.agent.status, "revoked");
  assert.equal(result.agent.revokedAt, NOW);
  assert.equal(
    authorizeAction(result.agent, { capability: "market_creator" }).allowed,
    false,
  );
});

// ── Grants ────────────────────────────────────────────────────────────────────

test("only the owner may grant a capability", () => {
  const result = grantCapability(agent({ capabilities: [] }), {
    requestedBy: OPERATOR,
    capability: "researcher",
  });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, "not_owner");
});

test("a grant above the agent's authority level is refused, not silently stored", () => {
  // Storing it would read in the UI like a working permission.
  const result = grantCapability(agent({ authorityLevel: AUTHORITY_LEVELS.CREATE }), {
    requestedBy: OWNER,
    capability: "copy_source",
  });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, "insufficient_authority");
});

test("granting is idempotent", () => {
  const first = grantCapability(agent(), { requestedBy: OWNER, capability: "researcher" });
  assert.equal(first.ok, true);
  assert.equal(
    first.ok && first.agent.capabilities.filter((c) => c === "researcher").length,
    1,
  );
});

test("a revoked agent cannot be granted anything", () => {
  const result = grantCapability(agent({ status: "revoked" }), {
    requestedBy: OWNER,
    capability: "researcher",
  });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, "revoked");
});

// ── Misc ──────────────────────────────────────────────────────────────────────

test("capability names are validated", () => {
  for (const capability of AGENT_CAPABILITIES) assert.equal(isAgentCapability(capability), true);
  assert.equal(isAgentCapability("withdraw_treasury"), false);
});

test("default limits let a new agent look and nothing else", () => {
  const limits = defaultLimits();
  assert.ok(limits.maxPositionUsdc <= 5);
  assert.ok(limits.maxDailyExposureUsdc <= 20);
  assert.ok(limits.maxActiveMarkets <= 3);
});

test("metadata is hashed so an off-chain document cannot be swapped silently", () => {
  const a = metadataHash('{"name":"Acme"}');
  assert.equal(a, metadataHash('{"name":"Acme"}'));
  assert.notEqual(a, metadataHash('{"name":"Acme "}'));
  // SHA-256, bare hex, no `0x` prefix — Soroban's `env.crypto().sha256()` is what
  // a contract could recompute, and Stellar tooling writes hex unprefixed.
  assert.match(a, /^[0-9a-f]{64}$/);
});

// ── Idempotent registration ───────────────────────────────────────────────────

test("re-registering the same owner/operator/payout is an idempotent success", () => {
  const existing = agent();
  const verdict = evaluateRegistrationReplay(existing, {
    ownerWallet: OWNER,
    operatorWallet: OPERATOR,
    payoutWallet: OWNER,
  });
  assert.equal(verdict.ok, true);
});

test("whitespace on wallets does not break idempotent registration matching", () => {
  const existing = agent();
  const verdict = evaluateRegistrationReplay(existing, {
    ownerWallet: `  ${OWNER}  `,
    operatorWallet: `\t${OPERATOR}`,
    payoutWallet: ` ${OWNER}`,
  });
  assert.equal(verdict.ok, true);
});

test("a different owner claiming the same agentId is a conflict", () => {
  const verdict = evaluateRegistrationReplay(agent(), {
    ownerWallet: STRANGER,
    operatorWallet: OPERATOR,
    payoutWallet: STRANGER,
  });
  assert.equal(verdict.ok, false);
  if (!verdict.ok) assert.equal(verdict.reason, "owner_mismatch");
});

test("a different operator on an existing agentId is a conflict", () => {
  const verdict = evaluateRegistrationReplay(agent(), {
    ownerWallet: OWNER,
    operatorWallet: STRANGER,
    payoutWallet: OWNER,
  });
  assert.equal(verdict.ok, false);
  if (!verdict.ok) assert.equal(verdict.reason, "operator_mismatch");
});

test("a different payout wallet on an existing agentId is a conflict", () => {
  const verdict = evaluateRegistrationReplay(agent(), {
    ownerWallet: OWNER,
    operatorWallet: OPERATOR,
    payoutWallet: STRANGER,
  });
  assert.equal(verdict.ok, false);
  if (!verdict.ok) assert.equal(verdict.reason, "payout_mismatch");
});

test("revoked agents cannot be revived by an idempotent register replay", () => {
  const revoked = revokeAgent(agent(), { requestedBy: OWNER, reason: "key leak", at: NOW });
  assert.equal(revoked.ok, true);
  if (!revoked.ok) return;
  const verdict = evaluateRegistrationReplay(revoked.agent, {
    ownerWallet: OWNER,
    operatorWallet: OPERATOR,
    payoutWallet: OWNER,
  });
  assert.equal(verdict.ok, false);
  if (!verdict.ok) assert.equal(verdict.reason, "revoked");
});

test("capability drift does not make a matching identity look like a conflict", () => {
  // Clients often re-send a registration body after grants changed server-side.
  const existing = agent({ capabilities: ["researcher", "market_creator", "council_juror"] });
  const verdict = evaluateRegistrationReplay(existing, {
    ownerWallet: OWNER,
    operatorWallet: OPERATOR,
    payoutWallet: OWNER,
  });
  assert.equal(verdict.ok, true);
});
