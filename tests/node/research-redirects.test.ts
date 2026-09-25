import assert from "node:assert/strict";
import test from "node:test";

import {
  gatewayFetch,
  invalidateResearchCache,
  resetBudgets,
  resetResearchCache,
  type GatewayFetchArgs,
} from "../../lib/research/gateway";
import {
  checkRedirectHopPolicy,
  domainPolicyFromEnv,
  sanitizeHeadersForRedirect,
  type DomainPolicy,
} from "../../lib/research/ssrf";

const PUBLIC_POLICY: DomainPolicy = { allow: [], deny: [] };
const publicDns = async () => ["93.184.216.34"];
const privateDns = async () => ["127.0.0.1"];

function htmlResponse(body: string, init: ResponseInit = {}): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
    ...init,
  });
}

function redirectTo(location: string, status = 302): Response {
  return new Response(null, { status, headers: { location } });
}

function fresh() {
  resetBudgets();
  resetResearchCache();
}

// ── Positive Redirect Scenarios ───────────────────────────────────────────────

test("single hop redirect completes successfully and records redirectChain", async () => {
  fresh();
  let calls = 0;
  const result = await gatewayFetch({
    url: "https://example.com/initial",
    agentId: "oracle",
    policy: PUBLIC_POLICY,
    resolve: publicDns,
    fetchImpl: async () => {
      calls += 1;
      return calls === 1 ? redirectTo("https://example.com/target") : htmlResponse("<h1>Evidence</h1>");
    },
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.redirects, 1);
  assert.equal(result.finalUrl, "https://example.com/target");
  assert.deepEqual(result.redirectChain, [
    "https://example.com/initial",
    "https://example.com/target",
  ]);
  assert.match(result.body, /Evidence/);
});

test("zero redirects returns redirectChain with single original URL", async () => {
  fresh();
  const result = await gatewayFetch({
    url: "https://example.com/direct",
    agentId: "oracle",
    policy: PUBLIC_POLICY,
    resolve: publicDns,
    fetchImpl: async () => htmlResponse("Direct hit"),
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.redirects, 0);
  assert.deepEqual(result.redirectChain, ["https://example.com/direct"]);
});

test("relative redirect paths resolve correctly against previous hop", async () => {
  fresh();
  let calls = 0;
  const result = await gatewayFetch({
    url: "https://example.com/v1/feed",
    agentId: "oracle",
    policy: PUBLIC_POLICY,
    resolve: publicDns,
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return redirectTo("../v2/items?page=1");
      if (calls === 2) return redirectTo("details/99");
      return htmlResponse("item 99 details");
    },
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.redirects, 2);
  assert.equal(result.finalUrl, "https://example.com/v2/details/99");
  assert.deepEqual(result.redirectChain, [
    "https://example.com/v1/feed",
    "https://example.com/v2/items?page=1",
    "https://example.com/v2/details/99",
  ]);
});

// ── Negative Redirect Boundaries ──────────────────────────────────────────────

test("immediate self-redirect is caught as a redirect_loop", async () => {
  fresh();
  const result = await gatewayFetch({
    url: "https://example.com/same",
    agentId: "oracle",
    policy: PUBLIC_POLICY,
    resolve: publicDns,
    fetchImpl: async () => redirectTo("https://example.com/same"),
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.kind, "redirect_loop");
  assert.match(result.detail, /redirect cycle or duplicate target/);
});

test("3-hop cycle (A -> B -> C -> A) is detected and blocked", async () => {
  fresh();
  let step = 0;
  const result = await gatewayFetch({
    url: "https://example.com/stepA",
    agentId: "oracle",
    policy: PUBLIC_POLICY,
    resolve: publicDns,
    fetchImpl: async () => {
      step += 1;
      if (step === 1) return redirectTo("https://example.com/stepB");
      if (step === 2) return redirectTo("https://example.com/stepC");
      if (step === 3) return redirectTo("https://example.com/stepA");
      return htmlResponse("unreachable");
    },
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.kind, "redirect_loop");
});

test("protocol downgrade from https to http on redirect is refused", async () => {
  fresh();
  const result = await gatewayFetch({
    url: "https://example.com/data",
    agentId: "oracle",
    policy: PUBLIC_POLICY,
    resolve: publicDns,
    fetchImpl: async () => redirectTo("http://example.com/data"),
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.kind, "protocol_downgrade");
  assert.match(result.detail, /downgrades protocol/);
});

test("redirect to private IP or loopback is blocked at the redirect hop", async () => {
  fresh();
  let step = 0;
  const result = await gatewayFetch({
    url: "https://public-site.com/bounce",
    agentId: "oracle",
    policy: PUBLIC_POLICY,
    resolve: async (host) => (host === "public-site.com" ? ["93.184.216.34"] : ["169.254.169.254"]),
    fetchImpl: async () => {
      step += 1;
      return step === 1 ? redirectTo("http://169.254.169.254/latest/meta-data/") : htmlResponse("secrets");
    },
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.kind, "blocked");
  assert.equal(step, 1, "redirect target must never be fetched after SSRF failure");
});

test("redirect with embedded credentials in location header is refused", async () => {
  fresh();
  const result = await gatewayFetch({
    url: "https://example.com/login-bounce",
    agentId: "oracle",
    policy: PUBLIC_POLICY,
    resolve: publicDns,
    fetchImpl: async () => redirectTo("https://user:password@example.com/secret"),
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.kind, "blocked");
  assert.equal(result.kind === "blocked" && result.reason, "credentials");
});

test("redirect without location header returns invalid_redirect", async () => {
  fresh();
  const result = await gatewayFetch({
    url: "https://example.com/bad-301",
    agentId: "oracle",
    policy: PUBLIC_POLICY,
    resolve: publicDns,
    fetchImpl: async () => new Response(null, { status: 301 }),
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.kind, "invalid_redirect");
});

test("redirect with unparseable location returns invalid_redirect", async () => {
  fresh();
  const result = await gatewayFetch({
    url: "https://example.com/bad-target",
    agentId: "oracle",
    policy: PUBLIC_POLICY,
    resolve: publicDns,
    fetchImpl: async () => redirectTo("http://[invalid-ipv6/target"),
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.kind, "invalid_redirect");
});

test("cross-domain redirect is blocked when allowCrossDomainRedirects is false", async () => {
  fresh();
  const result = await gatewayFetch({
    url: "https://trusted.org/source",
    agentId: "oracle",
    allowCrossDomainRedirects: false,
    resolve: publicDns,
    fetchImpl: async () => redirectTo("https://untrusted-redirect.org/source"),
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.kind, "blocked");
  assert.equal(result.kind === "blocked" && result.reason, "cross_domain");
});

test("redirect to domain on deny list is blocked", async () => {
  fresh();
  const result = await gatewayFetch({
    url: "https://allowed.com/start",
    agentId: "oracle",
    policy: { allow: [], deny: ["malicious.com"] },
    resolve: publicDns,
    fetchImpl: async () => redirectTo("https://malicious.com/payload"),
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.kind, "blocked");
  assert.equal(result.kind === "blocked" && result.reason, "hostname");
});

// ── Security & Header Privacy ─────────────────────────────────────────────────

test("cross-origin redirects scrub sensitive auth, tokens, and wallet identifiers", async () => {
  fresh();
  let calls = 0;
  let forwardedHeaders: Record<string, string> = {};

  const result = await gatewayFetch({
    url: "https://first-origin.com/fetch",
    agentId: "oracle",
    headers: {
      authorization: "Bearer agent-api-key",
      cookie: "session=xyz",
      "x-api-key": "secret-123",
      "x-stellar-account": "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
      "x-wallet-address": "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
      "x-spend-permission": "spend-perm-abc",
      "user-agent": "Mimir-CustomBot",
      "x-request-id": "req-987",
    },
    resolve: publicDns,
    fetchImpl: async (_url, init) => {
      calls += 1;
      if (calls === 1) return redirectTo("https://second-origin.org/destination");
      forwardedHeaders = (init?.headers as Record<string, string>) ?? {};
      return htmlResponse("safe response");
    },
  });

  assert.equal(result.ok, true);
  // Sensitive headers must be scrubbed
  assert.equal(forwardedHeaders["authorization"], undefined);
  assert.equal(forwardedHeaders["cookie"], undefined);
  assert.equal(forwardedHeaders["x-api-key"], undefined);
  assert.equal(forwardedHeaders["x-stellar-account"], undefined);
  assert.equal(forwardedHeaders["x-wallet-address"], undefined);
  assert.equal(forwardedHeaders["x-spend-permission"], undefined);
  // Non-sensitive context is preserved
  assert.equal(forwardedHeaders["x-request-id"], "req-987");
  assert.equal(forwardedHeaders["user-agent"], "Mimir-CustomBot");
});

// ── Cancellation & Cache Invalidation ─────────────────────────────────────────

test("cancellation via AbortSignal short-circuits during redirect loop", async () => {
  fresh();
  const controller = new AbortController();
  let calls = 0;

  const result = await gatewayFetch({
    url: "https://example.com/step1",
    agentId: "oracle",
    signal: controller.signal,
    policy: PUBLIC_POLICY,
    resolve: publicDns,
    fetchImpl: async () => {
      calls += 1;
      controller.abort();
      return redirectTo("https://example.com/step2");
    },
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.kind, "cancelled");
});

test("cache invalidation purges cached redirect result", async () => {
  fresh();
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return calls % 2 === 1
      ? redirectTo("https://example.com/final")
      : htmlResponse(`body-${calls}`);
  };

  const args: GatewayFetchArgs = {
    url: "https://example.com/initial",
    agentId: "oracle",
    policy: PUBLIC_POLICY,
    resolve: publicDns,
    fetchImpl,
  };

  const res1 = await gatewayFetch(args);
  assert.equal(res1.ok, true);
  if (!res1.ok) return;
  assert.equal(res1.fromCache, false);

  const res2 = await gatewayFetch(args);
  assert.equal(res2.ok, true);
  if (!res2.ok) return;
  assert.equal(res2.fromCache, true);

  // Invalidate cache
  invalidateResearchCache("https://example.com/initial");

  const res3 = await gatewayFetch(args);
  assert.equal(res3.ok, true);
  if (!res3.ok) return;
  assert.equal(res3.fromCache, false);
});
