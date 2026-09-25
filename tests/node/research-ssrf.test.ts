import assert from "node:assert/strict";
import test from "node:test";

import {
  checkDomainPolicy,
  checkRedirectHopPolicy,
  checkResolvedAddresses,
  checkUrl,
  domainPolicyFromEnv,
  isPrivateAddress,
  isPrivateIpv4,
  isPrivateIpv6,
  parseDomainList,
  sanitizeHeadersForRedirect,
} from "../../lib/research/ssrf";

// ── The attacks this module exists to stop ────────────────────────────────────

test("cloud instance metadata is blocked", () => {
  // The single highest-value SSRF target: it hands out credentials.
  for (const url of [
    "http://169.254.169.254/latest/meta-data/",
    "http://169.254.169.254/computeMetadata/v1/",
    "http://metadata.google.internal/computeMetadata/v1/",
    "http://metadata/computeMetadata/v1/",
    "http://instance-data/latest/meta-data/",
  ]) {
    const verdict = checkUrl(url);
    assert.equal(verdict.allowed, false, `not blocked: ${url}`);
  }
});

test("loopback is blocked by name and by literal", () => {
  for (const url of [
    "http://localhost:8080/api",
    "http://127.0.0.1:3000/api/vs",
    "http://127.1.2.3/",
    "http://[::1]:3000/",
  ]) {
    assert.equal(checkUrl(url).allowed, false, `not blocked: ${url}`);
  }
});

test("private ranges are blocked", () => {
  for (const url of [
    "http://10.0.0.5/secret",
    "http://192.168.1.1/",
    "http://172.16.0.1/",
    "http://172.31.255.255/",
    "http://100.64.0.1/",
  ]) {
    assert.equal(checkUrl(url).allowed, false, `not blocked: ${url}`);
  }
});

test("172.32 is public — the private range stops at 172.31", () => {
  // Off-by-one here would silently block legitimate hosts.
  assert.equal(isPrivateIpv4("172.32.0.1"), false);
  assert.equal(isPrivateIpv4("172.15.0.1"), false);
  assert.equal(isPrivateIpv4("172.16.0.1"), true);
  assert.equal(isPrivateIpv4("172.31.0.1"), true);
});

test("non-http schemes cannot be fetched at all", () => {
  for (const url of [
    "file:///etc/passwd",
    "gopher://example.com/",
    "ftp://example.com/x",
    "data:text/html,<script>alert(1)</script>",
  ]) {
    const verdict = checkUrl(url);
    assert.equal(verdict.allowed, false, `not blocked: ${url}`);
  }
  // javascript: has no host, so it fails as malformed or on protocol — either is
  // a refusal, which is what matters.
  assert.equal(checkUrl("javascript:alert(1)").allowed, false);
});

test("credentials in a URL are refused", () => {
  const verdict = checkUrl("http://user:pass@example.com/");
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.reason, "credentials");
});

test("internal service ports are refused so the gateway cannot port-scan", () => {
  for (const url of [
    "http://example.com:6379/",
    "http://example.com:5432/",
    "http://example.com:22/",
    "http://example.com:9200/",
  ]) {
    const verdict = checkUrl(url);
    assert.equal(verdict.allowed, false, `not blocked: ${url}`);
    assert.equal(verdict.reason, "port");
  }
});

test("the ordinary web ports are allowed", () => {
  for (const url of [
    "https://example.com/report",
    "http://example.com/report",
    "https://example.com:443/report",
    "http://example.com:80/report",
    "https://example.com:8443/report",
  ]) {
    assert.equal(checkUrl(url).allowed, true, `wrongly blocked: ${url}`);
  }
});

test("internal-by-convention suffixes are blocked", () => {
  for (const url of [
    "http://api.internal/x",
    "http://db.local/x",
    "http://svc.intranet/x",
    "http://printer.lan/x",
    "http://foo.home.arpa/x",
  ]) {
    assert.equal(checkUrl(url).allowed, false, `not blocked: ${url}`);
  }
});

test("a malformed URL is refused rather than guessed at", () => {
  assert.equal(checkUrl("not a url").allowed, false);
  assert.equal(checkUrl("").allowed, false);
});

test("an ordinary public source is allowed", () => {
  assert.equal(checkUrl("https://www.coingecko.com/en/coins/bitcoin").allowed, true);
  assert.equal(checkUrl("https://api.weather.gov/points/40,-70").allowed, true);
});

// ── DNS rebinding: why a static check is not enough ───────────────────────────

test("a public hostname resolving to a private address is refused", () => {
  // checkUrl cannot see this: the host is public, the A record is not.
  const verdict = checkResolvedAddresses(["127.0.0.1"]);
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.reason, "private_ip");
});

test("ONE private answer among several is enough to refuse", () => {
  // We do not choose which resolved address the socket uses, so any private
  // answer is exploitable.
  const verdict = checkResolvedAddresses(["93.184.216.34", "169.254.169.254"]);
  assert.equal(verdict.allowed, false);
  assert.match(verdict.detail ?? "", /169\.254\.169\.254/);
});

test("all-public resolution is allowed, and no resolution is refused", () => {
  assert.equal(checkResolvedAddresses(["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"]).allowed, true);
  assert.equal(checkResolvedAddresses([]).allowed, false);
});

test("IPv4-mapped IPv6 privates are caught", () => {
  assert.equal(isPrivateIpv6("::ffff:127.0.0.1"), true);
  assert.equal(isPrivateIpv6("::ffff:10.0.0.1"), true);
  assert.equal(isPrivateIpv6("::ffff:93.184.216.34"), false);
});

test("IPv6 loopback, link-local and unique-local are caught", () => {
  assert.equal(isPrivateIpv6("::1"), true);
  assert.equal(isPrivateIpv6("fe80::1"), true);
  assert.equal(isPrivateIpv6("fd00::1"), true);
  assert.equal(isPrivateIpv6("fc00::1"), true);
  assert.equal(isPrivateIpv6("2606:2800:220:1::1"), false);
});

test("isPrivateAddress covers both families", () => {
  assert.equal(isPrivateAddress("10.1.2.3"), true);
  assert.equal(isPrivateAddress("::1"), true);
  assert.equal(isPrivateAddress("93.184.216.34"), false);
});

// ── Domain policy ─────────────────────────────────────────────────────────────

test("an empty allowlist permits any public host", () => {
  const policy = { allow: [], deny: [] };
  assert.equal(checkDomainPolicy("https://example.com/x", policy).allowed, true);
});

test("a non-empty allowlist permits only its entries and their subdomains", () => {
  const policy = { allow: ["coingecko.com", "weather.gov"], deny: [] };
  assert.equal(checkDomainPolicy("https://coingecko.com/x", policy).allowed, true);
  assert.equal(checkDomainPolicy("https://api.coingecko.com/x", policy).allowed, true);
  assert.equal(checkDomainPolicy("https://evil.com/x", policy).allowed, false);
});

test("a lookalike domain does not satisfy the allowlist", () => {
  // "notcoingecko.com" must not match "coingecko.com" by naive suffix check.
  const policy = { allow: ["coingecko.com"], deny: [] };
  assert.equal(checkDomainPolicy("https://notcoingecko.com/x", policy).allowed, false);
  assert.equal(checkDomainPolicy("https://coingecko.com.evil.net/x", policy).allowed, false);
});

test("deny wins over allow", () => {
  // An explicit block must not be overridable by a broad allow entry.
  const policy = { allow: ["example.com"], deny: ["ads.example.com"] };
  assert.equal(checkDomainPolicy("https://docs.example.com/x", policy).allowed, true);
  assert.equal(checkDomainPolicy("https://ads.example.com/x", policy).allowed, false);
});

test("a wildcard allow entry is accepted", () => {
  const policy = { allow: ["*.example.com"], deny: [] };
  assert.equal(checkDomainPolicy("https://api.example.com/x", policy).allowed, true);
  assert.equal(checkDomainPolicy("https://example.com/x", policy).allowed, true);
});

test("domain lists are parsed from env, trimmed and lowercased", () => {
  assert.deepEqual(parseDomainList(" A.com , b.COM ,, "), ["a.com", "b.com"]);
  assert.deepEqual(parseDomainList(undefined), []);
  const policy = domainPolicyFromEnv({
    RESEARCH_ALLOWED_DOMAINS: "coingecko.com",
    RESEARCH_DENIED_DOMAINS: "evil.com",
    RESEARCH_ALLOW_CROSS_DOMAIN_REDIRECTS: "false",
    RESEARCH_ALLOW_PROTOCOL_DOWNGRADE: "0",
    RESEARCH_MAX_REDIRECTS: "4",
  });
  assert.deepEqual(policy, {
    allow: ["coingecko.com"],
    deny: ["evil.com"],
    allowCrossDomainRedirects: false,
    disallowProtocolDowngrade: true,
    maxRedirects: 4,
  });
});

// ── Redirect Hop Policy ───────────────────────────────────────────────────────

test("checkRedirectHopPolicy permits valid same-origin and subdomain redirects", () => {
  const policy = { allow: ["example.com"], deny: [] };
  const v1 = checkRedirectHopPolicy("https://example.com/a", "https://example.com/b", policy);
  assert.equal(v1.allowed, true);

  const v2 = checkRedirectHopPolicy("https://example.com/a", "/relative/b", policy);
  assert.equal(v2.allowed, true);

  const v3 = checkRedirectHopPolicy("https://example.com/a", "https://api.example.com/b", policy);
  assert.equal(v3.allowed, true);
});

test("checkRedirectHopPolicy blocks protocol downgrade by default", () => {
  const policy = { allow: [], deny: [] };
  const verdict = checkRedirectHopPolicy("https://example.com/a", "http://example.com/b", policy);
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.reason, "protocol_downgrade");
});

test("checkRedirectHopPolicy blocks cross-domain redirects when disallowed", () => {
  const policy = { allow: [], deny: [], allowCrossDomainRedirects: false };
  const verdict = checkRedirectHopPolicy("https://example.com/a", "https://other.com/b", policy);
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.reason, "cross_domain");
});

test("checkRedirectHopPolicy blocks redirects to denied domains", () => {
  const policy = { allow: [], deny: ["blocked.com"] };
  const verdict = checkRedirectHopPolicy("https://example.com/a", "https://blocked.com/b", policy);
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.reason, "hostname");
});

test("sanitizeHeadersForRedirect strips auth and wallet tokens cross-origin", () => {
  const headers = {
    authorization: "Bearer secret",
    cookie: "session=123",
    "x-api-key": "key-456",
    "x-wallet-address": "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    "x-spend-permission": "perm-789",
    accept: "text/html",
    "user-agent": "Mimir-Bot",
  };

  const stripped = sanitizeHeadersForRedirect(headers, "https://example.com/a", "https://other.com/b");
  assert.equal(stripped.authorization, undefined);
  assert.equal(stripped.cookie, undefined);
  assert.equal(stripped["x-api-key"], undefined);
  assert.equal(stripped["x-wallet-address"], undefined);
  assert.equal(stripped["x-spend-permission"], undefined);
  assert.equal(stripped.accept, "text/html");
  assert.equal(stripped["user-agent"], "Mimir-Bot");

  const preserved = sanitizeHeadersForRedirect(headers, "https://example.com/a", "https://example.com/b");
  assert.equal(preserved.authorization, "Bearer secret");
  assert.equal(preserved["x-wallet-address"], "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5");
});

