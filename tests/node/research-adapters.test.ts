import assert from "node:assert/strict";
import test from "node:test";
import { RESEARCH_ADAPTERS, fetchWithAdapter, researchAdapter } from "../../lib/research/adapters";
import { recordCategoryCoverage, recordCategoryReject, recordSettlementAmbiguity, recordSourceFailure, researchMetricsSnapshot, resetResearchMetrics } from "../../lib/research/telemetry";

test("adapter manifest publishes every required capability and safety metadata", () => {
  const capabilities = new Set(RESEARCH_ADAPTERS.map((item) => item.capability));
  for (const required of ["official_web", "rss", "github_public_metadata", "sports_results", "weather_observations", "market_data", "release_calendar", "x402_bazaar"]) assert.ok(capabilities.has(required as never), `missing ${required}`);
  for (const adapter of RESEARCH_ADAPTERS) {
    assert.equal(adapter.readOnly, true);
    assert.match(adapter.price.maxAtomicPerRequest, /^\d+$/);
    assert.ok(adapter.freshnessSeconds > 0);
    assert.ok(["primary", "trusted", "discovered"].includes(adapter.trustTier));
  }
});

test("unknown and discovered adapters fail closed", async () => {
  const args = { url: "https://example.com", agentId: "agent-1" };
  assert.equal((await fetchWithAdapter("missing", args)).ok, false);
  const result = await fetchWithAdapter("x402-bazaar-v1", args);
  assert.equal(result.ok, false);
  assert.match("detail" in result ? result.detail : "", /admission/);
  assert.equal(researchAdapter(" OFFICIAL-WEB-V1 ")?.capability, "official_web");
});

test("operational telemetry counts all four roadmap dimensions", () => {
  resetResearchMetrics();
  recordCategoryCoverage("Crypto");
  recordCategoryReject("too_few_sources");
  recordSourceFailure("transport");
  recordSettlementAmbiguity("sports");
  assert.deepEqual(researchMetricsSnapshot(), { coverage: { crypto: 1 }, rejects: { too_few_sources: 1 }, sourceFailures: { transport: 1 }, settlementAmbiguity: { sports: 1 }, allowlistRejects: {} });
});
