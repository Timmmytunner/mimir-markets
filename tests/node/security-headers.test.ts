import assert from "node:assert/strict";
import test from "node:test";
import nextConfig from "../../next.config.js";

/**
 * Security-header regression matrix for next.config.js.
 *
 * Rollback: restore the previous headers() block in next.config.js and this
 * fixture if a header change breaks wallet framing (xBull/Albedo) or funded
 * connect flows. Prefer reverting the config, not relaxing CSP wildcards.
 */

const REQUIRED_KEYS = [
  "Content-Security-Policy",
  "Strict-Transport-Security",
  "X-Frame-Options",
  "X-Content-Type-Options",
  "Referrer-Policy",
  "Permissions-Policy",
  "Cross-Origin-Opener-Policy",
] as const;

const EXPECTED_STATIC = {
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(self)",
  "Cross-Origin-Opener-Policy": "same-origin-allow-popups",
} as const;

const CSP_DIRECTIVES = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "font-src 'self' data:",
  "connect-src 'self' https: wss:",
  "frame-src 'self' https://wallet.xbull.app https://albedo.link",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
  "upgrade-insecure-requests",
] as const;

async function headerMatrix() {
  assert.ok(nextConfig.headers, "headers() must be configured");
  const rules = await nextConfig.headers!();
  assert.equal(rules.length, 1, "exactly one global header rule");
  assert.equal(rules[0].source, "/:path*", "global route coverage");
  const entries = rules[0].headers.map((entry: { key: string; value: string }) => [entry.key, entry.value] as const);
  assert.equal(new Set(entries.map(([key]) => key)).size, entries.length, "duplicate security header keys");
  return new Map(entries);
}

test("positive: all routes receive the complete browser security-header matrix", async () => {
  const headers = await headerMatrix();
  for (const key of REQUIRED_KEYS) assert.ok(headers.has(key), `missing ${key}`);
  for (const [key, value] of Object.entries(EXPECTED_STATIC)) {
    assert.equal(headers.get(key), value, key);
  }
});

test("positive: CSP is fail-closed with an explicit wallet frame allowlist", async () => {
  const headers = await headerMatrix();
  const csp = headers.get("Content-Security-Policy") ?? "";
  for (const directive of CSP_DIRECTIVES) {
    assert.match(csp, new RegExp(directive.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), directive);
  }
});

test("negative: wallet frame policy stays origin-scoped (no scheme wildcards)", async () => {
  const headers = await headerMatrix();
  const csp = headers.get("Content-Security-Policy") ?? "";
  assert.doesNotMatch(csp, /frame-src\s+https?:\/\//, "frame-src must not use bare scheme wildcards");
  assert.doesNotMatch(csp, /frame-ancestors\s+\*/, "frame-ancestors must not allow any parent");
  assert.doesNotMatch(csp, /object-src\s+'?self'?/, "object-src must remain none");
});

test("boundary: framing and HSTS values stay at funded-flow safe extrema", async () => {
  const headers = await headerMatrix();
  assert.equal(headers.get("X-Frame-Options"), "DENY");
  const hsts = headers.get("Strict-Transport-Security") ?? "";
  assert.match(hsts, /max-age=31536000/);
  assert.match(hsts, /includeSubDomains/);
  assert.doesNotMatch(hsts, /max-age=0/, "HSTS must not be disabled");
  const coop = headers.get("Cross-Origin-Opener-Policy") ?? "";
  assert.match(coop, /same-origin-allow-popups/, "Albedo popup signing requires allow-popups");
});

test("failure: security headers must not embed credentials, secrets, or env-specific values", async () => {
  const headers = await headerMatrix();
  const secretShapes = [
    /(?:S[A-Z2-7]{55})/, // stellar secret key shape
    /(?:api[_-]?key|secret|token|password|private[_-]?key)\s*[=:]/i,
    /(?:sk_live|rk_live|ghp_|github_pat_)/i,
    /(?:localhost|127\.0\.0\.1|0\.0\.0\.0)/i,
  ];
  for (const [key, value] of headers.entries()) {
    for (const shape of secretShapes) {
      assert.doesNotMatch(value, shape, `${key} must not leak credential/env shape`);
    }
  }
});

test("regression: Permissions-Policy keeps payment self-scoped and sensors off", async () => {
  const headers = await headerMatrix();
  const pp = headers.get("Permissions-Policy") ?? "";
  assert.match(pp, /camera=\(\)/);
  assert.match(pp, /microphone=\(\)/);
  assert.match(pp, /geolocation=\(\)/);
  assert.match(pp, /payment=\(self\)/);
  assert.doesNotMatch(pp, /payment=\(\)/, "payment=(self) required for funded checkout surfaces");
});
