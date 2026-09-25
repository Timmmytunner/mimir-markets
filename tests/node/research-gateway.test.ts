import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_REDIRECTS,
  MAX_RESPONSE_BYTES,
  budgetRemaining,
  gatewayFetch,
  resetBudgets,
  resetResearchCache,
  validateHop,
} from "../../lib/research/gateway";

const PUBLIC_POLICY = { allow: [], deny: [] };
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

// ── Hop validation ────────────────────────────────────────────────────────────

test("a public URL resolving publicly is allowed", async () => {
  const hop = await validateHop("https://example.com/report", PUBLIC_POLICY, publicDns);
  assert.equal(hop.allowed, true);
});

test("a public hostname resolving to loopback is refused — DNS rebinding", async () => {
  const hop = await validateHop("https://evil.example.com/", PUBLIC_POLICY, privateDns);
  assert.equal(hop.allowed, false);
  assert.equal(hop.allowed === false && hop.reason, "private_ip");
});

test("the domain policy is applied before DNS is even consulted", async () => {
  let resolved = false;
  const spy = async () => {
    resolved = true;
    return ["93.184.216.34"];
  };
  const hop = await validateHop("https://evil.com/", { allow: ["good.com"], deny: [] }, spy);
  assert.equal(hop.allowed, false);
  assert.equal(resolved, false, "DNS is the expensive check and must come last");
});

test("a host that does not resolve is refused, not assumed public", async () => {
  const hop = await validateHop("https://nx.example/", PUBLIC_POLICY, async () => {
    throw new Error("ENOTFOUND");
  });
  assert.equal(hop.allowed, false);
});

// ── Fetching ──────────────────────────────────────────────────────────────────

test("a plain successful fetch returns the body and a content hash", async () => {
  fresh();
  const result = await gatewayFetch({
    url: "https://example.com/report",
    agentId: "oracle",
    policy: PUBLIC_POLICY,
    resolve: publicDns,
    fetchImpl: async () => htmlResponse("<html>BTC closed at 98,410</html>"),
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.match(result.body, /98,410/);
  // SHA-256, bare hex — see lib/content-hash.ts.
  assert.match(result.contentHash, /^[0-9a-f]{64}$/);
  assert.equal(result.fromCache, false);
  assert.equal(result.redirects, 0);
});

test("an SSRF target is refused with a typed reason, not an exception", async () => {
  fresh();
  const result = await gatewayFetch({
    url: "http://169.254.169.254/latest/meta-data/",
    agentId: "oracle",
    policy: PUBLIC_POLICY,
    resolve: publicDns,
    fetchImpl: async () => htmlResponse("credentials"),
  });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.kind, "blocked");
});

test("a redirect INTO the metadata service is caught at the hop", async () => {
  // The reason redirects are followed manually: automatic following would make
  // this fetch succeed.
  fresh();
  let calls = 0;
  const result = await gatewayFetch({
    url: "https://example.com/start",
    agentId: "oracle",
    policy: PUBLIC_POLICY,
    resolve: publicDns,
    fetchImpl: async () => {
      calls += 1;
      return calls === 1
        ? redirectTo("http://169.254.169.254/latest/meta-data/")
        : htmlResponse("credentials");
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.kind, "blocked");
  assert.equal(calls, 1, "the second hop must never be requested");
});

test("a redirect to a private IP is caught even when the first host was fine", async () => {
  fresh();
  const result = await gatewayFetch({
    url: "https://example.com/start",
    agentId: "oracle",
    policy: PUBLIC_POLICY,
    resolve: publicDns,
    fetchImpl: async () => redirectTo("http://10.0.0.5/secret"),
  });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.kind, "blocked");
});

test("a legitimate redirect chain is followed", async () => {
  fresh();
  let calls = 0;
  const result = await gatewayFetch({
    url: "https://example.com/a",
    agentId: "oracle",
    policy: PUBLIC_POLICY,
    resolve: publicDns,
    fetchImpl: async () => {
      calls += 1;
      return calls === 1 ? redirectTo("https://example.com/b") : htmlResponse("final");
    },
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.body, "final");
  assert.equal(result.redirects, 1);
  assert.equal(result.finalUrl, "https://example.com/b");
});

test("a redirect loop is bounded", async () => {
  fresh();
  const result = await gatewayFetch({
    url: "https://example.com/loop",
    agentId: "oracle",
    policy: PUBLIC_POLICY,
    resolve: publicDns,
    fetchImpl: async () => redirectTo("https://example.com/loop"),
  });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && (result.kind === "redirect_loop" || result.kind === "too_many_redirects"), true);
  assert.ok(MAX_REDIRECTS < 10);
});

test("a multi-hop redirect cycle is caught as a redirect_loop", async () => {
  fresh();
  let calls = 0;
  const result = await gatewayFetch({
    url: "https://example.com/a",
    agentId: "oracle",
    policy: PUBLIC_POLICY,
    resolve: publicDns,
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return redirectTo("https://example.com/b");
      if (calls === 2) return redirectTo("https://example.com/a");
      return htmlResponse("unreachable");
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.kind, "redirect_loop");
});

test("a linear redirect chain exceeding maxRedirects is refused", async () => {
  fresh();
  let step = 0;
  const result = await gatewayFetch({
    url: "https://example.com/hop0",
    agentId: "oracle",
    policy: PUBLIC_POLICY,
    maxRedirects: 2,
    resolve: publicDns,
    fetchImpl: async () => {
      step += 1;
      return redirectTo(`https://example.com/hop${step}`);
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.kind, "too_many_redirects");
});

test("redirectChain records the full sequence of visited URLs", async () => {
  fresh();
  let step = 0;
  const result = await gatewayFetch({
    url: "https://example.com/start",
    agentId: "oracle",
    policy: PUBLIC_POLICY,
    resolve: publicDns,
    fetchImpl: async () => {
      step += 1;
      if (step === 1) return redirectTo("https://example.com/middle");
      if (step === 2) return redirectTo("https://example.com/final");
      return htmlResponse("done");
    },
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.finalUrl, "https://example.com/final");
  assert.equal(result.redirects, 2);
  assert.deepEqual(result.redirectChain, [
    "https://example.com/start",
    "https://example.com/middle",
    "https://example.com/final",
  ]);
});

test("protocol downgrade from https to http on redirect is refused", async () => {
  fresh();
  const result = await gatewayFetch({
    url: "https://example.com/secure",
    agentId: "oracle",
    policy: PUBLIC_POLICY,
    resolve: publicDns,
    fetchImpl: async () => redirectTo("http://example.com/insecure"),
  });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.kind, "protocol_downgrade");
});

test("cross-domain redirect is refused when allowCrossDomainRedirects is false", async () => {
  fresh();
  const result = await gatewayFetch({
    url: "https://example.com/a",
    agentId: "oracle",
    policy: { allow: [], deny: [], allowCrossDomainRedirects: false },
    resolve: publicDns,
    fetchImpl: async () => redirectTo("https://other-domain.com/b"),
  });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.kind, "blocked");
  assert.equal(result.ok === false && result.kind === "blocked" && result.reason, "cross_domain");
});

test("sensitive headers are stripped on cross-origin redirects", async () => {
  fresh();
  let call = 0;
  let secondHopHeaders: Record<string, string> = {};
  const result = await gatewayFetch({
    url: "https://source.com/a",
    agentId: "oracle",
    policy: PUBLIC_POLICY,
    headers: {
      authorization: "Bearer secret-token",
      "x-api-key": "private-key-123",
      "x-wallet-address": "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
      "custom-trace": "trace-999",
    },
    resolve: publicDns,
    fetchImpl: async (_url, init) => {
      call += 1;
      if (call === 1) return redirectTo("https://target.com/b");
      secondHopHeaders = (init?.headers as Record<string, string>) ?? {};
      return htmlResponse("ok");
    },
  });
  assert.equal(result.ok, true);
  assert.equal(secondHopHeaders["authorization"], undefined);
  assert.equal(secondHopHeaders["x-api-key"], undefined);
  assert.equal(secondHopHeaders["x-wallet-address"], undefined);
  assert.equal(secondHopHeaders["custom-trace"], "trace-999");
});

test("empty or missing location on redirect returns invalid_redirect", async () => {
  fresh();
  const result = await gatewayFetch({
    url: "https://example.com/start",
    agentId: "oracle",
    policy: PUBLIC_POLICY,
    resolve: publicDns,
    fetchImpl: async () => new Response(null, { status: 302, headers: { location: "" } }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.kind, "invalid_redirect");
});

test("cancelled fetch with AbortSignal returns cancelled failure", async () => {
  fresh();
  const controller = new AbortController();
  controller.abort();
  const result = await gatewayFetch({
    url: "https://example.com/report",
    agentId: "oracle",
    signal: controller.signal,
    policy: PUBLIC_POLICY,
    resolve: publicDns,
    fetchImpl: async () => htmlResponse("not reached"),
  });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.kind, "cancelled");
});

test("a relative redirect target is resolved against the current URL", async () => {
  fresh();
  let calls = 0;
  const result = await gatewayFetch({
    url: "https://example.com/dir/a",
    agentId: "oracle",
    policy: PUBLIC_POLICY,
    resolve: publicDns,
    fetchImpl: async () => {
      calls += 1;
      return calls === 1 ? redirectTo("/dir/b") : htmlResponse("ok");
    },
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.finalUrl, "https://example.com/dir/b");
});

test("a non-text content type is refused", async () => {
  fresh();
  const result = await gatewayFetch({
    url: "https://example.com/file.zip",
    agentId: "oracle",
    policy: PUBLIC_POLICY,
    resolve: publicDns,
    fetchImpl: async () =>
      new Response("PK", { status: 200, headers: { "content-type": "application/zip" } }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.kind, "content_type");
});

test("an oversized response is REFUSED, not silently truncated", async () => {
  // A truncated source is a silent correctness hazard for settlement.
  fresh();
  const result = await gatewayFetch({
    url: "https://example.com/huge",
    agentId: "oracle",
    policy: PUBLIC_POLICY,
    resolve: publicDns,
    fetchImpl: async () => htmlResponse("x".repeat(MAX_RESPONSE_BYTES + 1_000)),
  });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.kind, "too_large");
});

test("a size limit is enforced even when Content-Length lies", async () => {
  fresh();
  const result = await gatewayFetch({
    url: "https://example.com/liar",
    agentId: "oracle",
    policy: PUBLIC_POLICY,
    resolve: publicDns,
    fetchImpl: async () =>
      new Response("y".repeat(MAX_RESPONSE_BYTES + 500), {
        status: 200,
        headers: { "content-type": "text/plain", "content-length": "10" },
      }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.kind, "too_large");
});

test("an upstream error is reported with its status", async () => {
  fresh();
  const result = await gatewayFetch({
    url: "https://example.com/gone",
    agentId: "oracle",
    policy: PUBLIC_POLICY,
    resolve: publicDns,
    fetchImpl: async () => new Response("nope", { status: 503 }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.kind, "http_error");
  assert.equal(result.ok === false && result.kind === "http_error" && result.status, 503);
});

test("a transport failure is a typed refusal, not a thrown error", async () => {
  fresh();
  const result = await gatewayFetch({
    url: "https://example.com/x",
    agentId: "oracle",
    policy: PUBLIC_POLICY,
    resolve: publicDns,
    fetchImpl: async () => {
      throw new Error("socket hang up");
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.kind, "transport");
});

// ── Cache ─────────────────────────────────────────────────────────────────────

test("an identical fetch is served from cache and does not hit the source twice", async () => {
  fresh();
  let calls = 0;
  const impl = async () => {
    calls += 1;
    return htmlResponse("cached body");
  };
  const args = {
    url: "https://example.com/report",
    agentId: "oracle",
    policy: PUBLIC_POLICY,
    resolve: publicDns,
    fetchImpl: impl,
  };
  const first = await gatewayFetch(args);
  const second = await gatewayFetch(args);
  assert.equal(calls, 1, "the source must not be hammered");
  assert.equal(first.ok && first.fromCache, false);
  assert.equal(second.ok && second.fromCache, true);
});

test("a cache hit does not consume request budget", async () => {
  fresh();
  const args = {
    url: "https://example.com/report",
    agentId: "oracle",
    policy: PUBLIC_POLICY,
    resolve: publicDns,
    fetchImpl: async () => htmlResponse("body"),
  };
  await gatewayFetch(args);
  const afterFirst = budgetRemaining("oracle").requests;
  await gatewayFetch(args);
  assert.equal(budgetRemaining("oracle").requests, afterFirst);
});

// ── Budget ────────────────────────────────────────────────────────────────────

test("an agent that exhausts its request budget is refused", async () => {
  fresh();
  const budget = { maxRequests: 2, maxBytes: 1_000_000 };
  const args = (n: number) => ({
    url: `https://example.com/${n}`,
    agentId: "greedy",
    policy: PUBLIC_POLICY,
    budget,
    resolve: publicDns,
    fetchImpl: async () => htmlResponse("body"),
  });
  assert.equal((await gatewayFetch(args(1))).ok, true);
  assert.equal((await gatewayFetch(args(2))).ok, true);
  const third = await gatewayFetch(args(3));
  assert.equal(third.ok, false);
  assert.equal(third.ok === false && third.kind, "budget");
});

test("budgets are per agent, so one greedy worker cannot starve another", async () => {
  fresh();
  const budget = { maxRequests: 1, maxBytes: 1_000_000 };
  const make = (agentId: string, n: number) => ({
    url: `https://example.com/${agentId}/${n}`,
    agentId,
    policy: PUBLIC_POLICY,
    budget,
    resolve: publicDns,
    fetchImpl: async () => htmlResponse("body"),
  });
  assert.equal((await gatewayFetch(make("a", 1))).ok, true);
  assert.equal((await gatewayFetch(make("a", 2))).ok, false);
  assert.equal((await gatewayFetch(make("b", 1))).ok, true, "agent b has its own budget");
});

test("a byte budget is enforced as well as a request count", async () => {
  fresh();
  const budget = { maxRequests: 100, maxBytes: 50 };
  const args = (n: number) => ({
    url: `https://example.com/${n}`,
    agentId: "chunky",
    policy: PUBLIC_POLICY,
    budget,
    resolve: publicDns,
    fetchImpl: async () => htmlResponse("z".repeat(60)),
  });
  assert.equal((await gatewayFetch(args(1))).ok, true);
  const second = await gatewayFetch(args(2));
  assert.equal(second.ok, false);
  assert.equal(second.ok === false && second.kind, "budget");
});

test("a blocked request still costs nothing, so a refusal cannot drain a budget", async () => {
  fresh();
  const before = budgetRemaining("oracle").requests;
  await gatewayFetch({
    url: "http://127.0.0.1/x",
    agentId: "oracle",
    policy: PUBLIC_POLICY,
    resolve: publicDns,
    fetchImpl: async () => htmlResponse("x"),
  });
  assert.equal(budgetRemaining("oracle").requests, before);
});

test("budgetRemaining reports what is left and when the window resets", async () => {
  fresh();
  const budget = { maxRequests: 5, maxBytes: 1_000 };
  await gatewayFetch({
    url: "https://example.com/x",
    agentId: "reporter",
    policy: PUBLIC_POLICY,
    budget,
    resolve: publicDns,
    fetchImpl: async () => htmlResponse("body"),
  });
  const remaining = budgetRemaining("reporter", budget);
  assert.equal(remaining.requests, 4);
  assert.ok(remaining.bytes < 1_000);
  assert.ok(remaining.windowResetsAt > Date.now());
});
