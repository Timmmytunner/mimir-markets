import assert from "node:assert/strict";
import test from "node:test";

import {
  checkDomainAllowlist,
  hostMatchesDomain,
  normalizeDomainPattern,
  normalizeDomainPatterns,
  normalizeHostname,
  patternSubsetOf,
} from "../../lib/research/allowlist";
import {
  checkDomainPolicy,
  composeDomainPolicy,
  domainPolicyDiagnostics,
} from "../../lib/research/ssrf";
import { gatewayFetch, resetBudgets, resetResearchCache } from "../../lib/research/gateway";
import { researchMetricsSnapshot, resetResearchMetrics } from "../../lib/research/telemetry";

// ── Hostname normalisation ────────────────────────────────────────────────────

test("hostnames are normalised before they are compared", () => {
  assert.equal(normalizeHostname("  Example.COM.  "), "example.com");
  assert.equal(normalizeHostname("sub.example.com.."), "sub.example.com");
  assert.equal(normalizeHostname("[::1]"), "::1");
  assert.equal(normalizeHostname("::ffff:127.0.0.1"), "::ffff:127.0.0.1");
  assert.equal(normalizeHostname("xn--bcher-kva.de"), "xn--bcher-kva.de");
});

test("internationalised names are punycoded so homographs cannot match", () => {
  assert.equal(normalizeHostname("bücher.de"), "xn--bcher-kva.de");
  // Cyrillic 'а' — renders as "apple.com" but is a different host.
  const homograph = normalizeHostname("аpple.com");
  assert.notEqual(homograph, "apple.com");
  assert.equal(homograph, "xn--pple-43d.com");
  assert.equal(hostMatchesDomain("аpple.com", "apple.com"), false);
});

test("values that are not bare hostnames are refused, not coerced", () => {
  for (const value of [
    "https://example.com",
    "example.com:8080",
    "user@example.com",
    "example.com/path",
    "example..com",
    "",
    "   ",
  ]) {
    assert.equal(normalizeHostname(value), null, `wrongly accepted: ${JSON.stringify(value)}`);
  }
});

// ── Pattern parsing ───────────────────────────────────────────────────────────

test("allowlist entries are normalised, wildcards preserved", () => {
  assert.deepEqual(normalizeDomainPattern("*.Example.COM"), {
    ok: true,
    pattern: "*.example.com",
    wildcard: true,
  });
  assert.deepEqual(normalizeDomainPattern("Example.com."), {
    ok: true,
    pattern: "example.com",
    wildcard: false,
  });
});

test("malformed allowlist entries fail with a reason instead of silently vanishing", () => {
  for (const entry of ["https://example.com", "example.com:443", "com", "*", "api.*.com", ""]) {
    const result = normalizeDomainPattern(entry);
    assert.equal(result.ok, false, `wrongly accepted: '${entry}'`);
  }
});

test("normalizeDomainPatterns de-duplicates and reports every invalid entry", () => {
  const { patterns, invalid } = normalizeDomainPatterns([
    "coingecko.com",
    "COINGECKO.COM",
    "https://weather.gov",
    "com",
  ]);
  assert.deepEqual(patterns, ["coingecko.com"]);
  assert.equal(invalid.length, 2);
});

// ── Matching ──────────────────────────────────────────────────────────────────

test("matching is label-boundary only — lookalikes never satisfy an entry", () => {
  assert.equal(hostMatchesDomain("coingecko.com", "coingecko.com"), true);
  assert.equal(hostMatchesDomain("api.coingecko.com", "coingecko.com"), true);
  assert.equal(hostMatchesDomain("notcoingecko.com", "coingecko.com"), false);
  assert.equal(hostMatchesDomain("coingecko.com.evil.net", "coingecko.com"), false);
});

test("a trailing DNS root dot cannot slip past a policy (regression)", () => {
  // `new URL("https://ads.example.com./").hostname` keeps the dot, which used to
  // walk straight past an exact deny entry.
  assert.equal(hostMatchesDomain("ads.example.com.", "ads.example.com"), true);
  assert.equal(hostMatchesDomain("example.com.", "example.com"), true);
  const denied = checkDomainPolicy("https://ads.example.com./x", { allow: [], deny: ["ads.example.com"] });
  assert.equal(denied.allowed, false);
  assert.equal(denied.reason, "hostname");
});

test("wildcards are leading-label only and cover the apex", () => {
  assert.equal(hostMatchesDomain("api.example.com", "*.example.com"), true);
  assert.equal(hostMatchesDomain("example.com", "*.example.com"), true);
  assert.equal(hostMatchesDomain("evil.com.attacker.net", "*.evil.com"), false);
  assert.equal(hostMatchesDomain("nested-ok.evil.com", "*.evil.com"), true);
});

test("patternSubsetOf only accepts entries inside the parent", () => {
  assert.equal(patternSubsetOf("api.example.com", "example.com"), true);
  assert.equal(patternSubsetOf("example.com", "*.example.com"), true);
  assert.equal(patternSubsetOf("evil.com", "example.com"), false);
  assert.equal(patternSubsetOf("notexample.com", "example.com"), false);
});

// ── Allowlist verdicts ────────────────────────────────────────────────────────

test("an empty allowlist stays unrestricted, but a wholly invalid one fails closed", () => {
  assert.equal(checkDomainAllowlist("https://anything.example/x", []).allowed, true);

  const unusable = checkDomainAllowlist("https://coingecko.com/x", ["https://coingecko.com"]);
  assert.equal(unusable.allowed, false);
  assert.equal(unusable.reason, "pattern_invalid");
});

test("a matching allowlist returns the entry that admitted the host", () => {
  const verdict = checkDomainAllowlist("https://api.coingecko.com./v3/price", ["coingecko.com"]);
  assert.equal(verdict.allowed, true);
  assert.equal(verdict.matched, "coingecko.com");

  const refused = checkDomainAllowlist("https://evil.com/x", ["coingecko.com"]);
  assert.equal(refused.allowed, false);
  assert.equal(refused.reason, "not_allowlisted");
});

// ── Policy composition: callers may narrow, never widen ───────────────────────

test("a request policy cannot clear or extend the operator allowlist", () => {
  const operator = { allow: ["good.com"], deny: [] as string[] };

  // Passing an empty allowlist used to mean "unrestricted" for the request.
  assert.deepEqual(composeDomainPolicy(operator, { allow: [], deny: [] }).allow, ["good.com"]);
  // A domain outside the operator list cannot be added; the intersection is empty.
  const widened = composeDomainPolicy(operator, { allow: ["evil.com"], deny: [] });
  assert.equal(widened.denyAll, true);
  // A subdomain of an operator entry is inside it, so it is kept.
  assert.deepEqual(composeDomainPolicy(operator, { allow: ["api.good.com"], deny: [] }).allow, ["api.good.com"]);
});

test("deny lists and redirect switches only ever tighten", () => {
  const composed = composeDomainPolicy(
    { allow: [], deny: ["ads.example.com"], allowCrossDomainRedirects: false, disallowProtocolDowngrade: false, maxRedirects: 5 },
    { allow: [], deny: ["tracker.example.com"], allowCrossDomainRedirects: true, disallowProtocolDowngrade: true, maxRedirects: 9 },
  );
  assert.deepEqual(composed.deny.sort(), ["ads.example.com", "tracker.example.com"]);
  assert.equal(composed.allowCrossDomainRedirects, false);
  assert.equal(composed.disallowProtocolDowngrade, true);
  assert.equal(composed.maxRedirects, 5);
});

test("denyAll refuses every host", () => {
  const verdict = checkDomainPolicy("https://good.com/x", { allow: ["good.com"], deny: [], denyAll: true });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.reason, "not_allowlisted");
});

test("diagnostics expose a configured-but-unusable allowlist", () => {
  const diagnostics = domainPolicyDiagnostics({
    RESEARCH_ALLOWED_DOMAINS: "https://coingecko.com,weather.gov",
    RESEARCH_DENIED_DOMAINS: "",
  });
  assert.equal(diagnostics.allowConfigured, true);
  assert.equal(diagnostics.allowInvalid.length, 1);
  assert.equal(diagnostics.allowInvalid[0]!.entry, "https://coingecko.com");
  assert.equal(diagnostics.denyConfigured, false);
});

// ── Gateway enforcement ───────────────────────────────────────────────────────

const DENY_ENV = {
  RESEARCH_ALLOWED_DOMAINS: undefined,
  RESEARCH_DENIED_DOMAINS: undefined,
  RESEARCH_REQUIRE_ALLOWLIST: undefined,
} as const;

const RESEARCH_ENV_KEYS = [
  "RESEARCH_ALLOWED_DOMAINS",
  "RESEARCH_DENIED_DOMAINS",
  "RESEARCH_REQUIRE_ALLOWLIST",
] as const;
type ResearchEnvKey = (typeof RESEARCH_ENV_KEYS)[number];

async function withEnv(
  vars: Partial<Record<ResearchEnvKey, string | undefined>>,
  run: () => Promise<void>,
): Promise<void> {
  const saved = RESEARCH_ENV_KEYS.map((key) => [key, process.env[key]] as const);
  try {
    for (const key of RESEARCH_ENV_KEYS) {
      const value = vars[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const publicDns = async () => ["93.184.216.34"];
function htmlResponse(body: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": "text/html" } });
}
function fresh(): void {
  resetBudgets();
  resetResearchCache();
  resetResearchMetrics();
}

test("gateway: a request policy cannot widen the operator allowlist", async () => {
  await withEnv({ ...DENY_ENV, RESEARCH_ALLOWED_DOMAINS: "good.com" }, async () => {
    fresh();
    const result = await gatewayFetch({
      url: "https://evil.com/exfiltrate",
      agentId: "oracle",
      policy: { allow: [], deny: [] },
      resolve: publicDns,
      fetchImpl: async () => htmlResponse("should never be fetched"),
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.kind, "blocked");
    assert.equal(result.kind === "blocked" && result.reason, "not_allowlisted");
    assert.equal(researchMetricsSnapshot().allowlistRejects.not_allowlisted, 1);
  });
});

test("gateway: the operator allowlist admits its domains and subdomains", async () => {
  await withEnv({ ...DENY_ENV, RESEARCH_ALLOWED_DOMAINS: "good.com" }, async () => {
    fresh();
    const allowed = await gatewayFetch({
      url: "https://api.good.com/report",
      agentId: "oracle",
      resolve: publicDns,
      fetchImpl: async () => htmlResponse("ok"),
    });
    assert.equal(allowed.ok, true);

    fresh();
    const blocked = await gatewayFetch({
      url: "https://good.com.evil.net/report",
      agentId: "oracle",
      resolve: publicDns,
      fetchImpl: async () => htmlResponse("ok"),
    });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.ok === false && blocked.kind, "blocked");
  });
});

test("gateway: a request allowlist outside the operator list denies everything", async () => {
  await withEnv({ ...DENY_ENV, RESEARCH_ALLOWED_DOMAINS: "good.com" }, async () => {
    fresh();
    const result = await gatewayFetch({
      url: "https://api.good.com/report",
      agentId: "oracle",
      policy: { allow: ["evil.com"], deny: [] },
      resolve: publicDns,
      fetchImpl: async () => htmlResponse("ok"),
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.kind, "blocked");
  });
});

test("gateway: caller allowlists narrow when the operator set none", async () => {
  await withEnv({ ...DENY_ENV }, async () => {
    fresh();
    const blocked = await gatewayFetch({
      url: "https://evil.com/report",
      agentId: "oracle",
      policy: { allow: ["good.com"], deny: [] },
      resolve: publicDns,
      fetchImpl: async () => htmlResponse("ok"),
    });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.ok === false && blocked.kind === "blocked" && blocked.reason, "not_allowlisted");

    fresh();
    const allowed = await gatewayFetch({
      url: "https://api.good.com/report",
      agentId: "oracle",
      policy: { allow: ["good.com"], deny: [] },
      resolve: publicDns,
      fetchImpl: async () => htmlResponse("ok"),
    });
    assert.equal(allowed.ok, true);
  });
});

test("gateway: a configured-but-unusable allowlist fails closed", async () => {
  await withEnv({ ...DENY_ENV, RESEARCH_ALLOWED_DOMAINS: "https://coingecko.com" }, async () => {
    fresh();
    const result = await gatewayFetch({
      url: "https://coingecko.com/x",
      agentId: "oracle",
      resolve: publicDns,
      fetchImpl: async () => htmlResponse("ok"),
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.kind, "blocked");
    assert.equal(researchMetricsSnapshot().allowlistRejects.pattern_invalid, 1);
  });
});

test("gateway: RESEARCH_REQUIRE_ALLOWLIST makes a missing allowlist a refusal", async () => {
  await withEnv({ ...DENY_ENV, RESEARCH_REQUIRE_ALLOWLIST: "1" }, async () => {
    fresh();
    const result = await gatewayFetch({
      url: "https://example.com/x",
      agentId: "oracle",
      resolve: publicDns,
      fetchImpl: async () => htmlResponse("ok"),
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.kind, "blocked");
    assert.equal(researchMetricsSnapshot().allowlistRejects.allowlist_unconfigured, 1);
  });
});
