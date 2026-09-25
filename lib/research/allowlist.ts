/**
 * Research-domain allowlist for the gateway.
 *
 * `./ssrf.ts` answers "is this host safe to connect to?". This module answers
 * "is this host *permitted* at all?" — it is the operator's domain policy, and
 * its whole job is to make the cheap tricks that slip past a string comparison
 * impossible.
 *
 * Why a dedicated normaliser. A naive exact/`endsWith` match against
 * `example.com` looks right and is not:
 *
 *   - `example.com.` — the DNS root dot. `new URL(url).hostname` keeps it, so a
 *     raw compare misses it. That is harmless for an allowlist (fail-closed) but
 *     a real bypass for a *deny* list: with `ads.example.com` blocked,
 *     `ads.example.com.` walked straight through.
 *   - `EXAMPLE.COM` — `URL` lowercases the host, but operator config entries are
 *     not lowercased, so `*.Example.COM` silently matched nothing.
 *   - `аpple.com` — a Cyrillic 'а' renders identically but is a different host.
 *     Punycoding before comparing (`xn--pple-43d.com`) keeps homographs out.
 *   - `notcoingecko.com` / `coingecko.com.evil.net` — suffix checks that are not
 *     label-aware admit both. Matching here is label-boundary only.
 *   - `*.evil.com` — a leading-label wildcard. `evil.com.attacker.net` must not
 *     satisfy it, and an embedded `*` is a config error rather than a regex.
 *
 * Nothing here performs I/O; it is pure policy so both the gateway and the
 * config loader can share one definition of "allowed".
 */

import { domainToASCII } from "node:url";

export type AllowlistReason =
  /** Host is valid and public, but the allowlist does not admit it. */
  | "not_allowlisted"
  /** The URL could not be parsed, or has no usable hostname. */
  | "malformed"
  /** The allowlist itself has no usable entries (garbage configuration). */
  | "pattern_invalid"
  /** Strict mode is on and no allowlist is configured at all. */
  | "allowlist_unconfigured";

export interface AllowlistVerdict {
  allowed: boolean;
  reason?: AllowlistReason;
  detail?: string;
  /** The normalised entry that admitted the host, when it was allowed. */
  matched?: string;
}

export interface NormalizedPattern {
  ok: true;
  /** Normalised entry, wildcard preserved as a leading `*.`. */
  pattern: string;
  wildcard: boolean;
}

export interface InvalidPattern {
  ok: false;
  detail: string;
}

const ASCII_HOST = /^[a-z0-9._-]+$/;
const IPV6_CHARS = /^[0-9a-f:.]+$/;
const IPV4_LITERAL = /^\d{1,3}(\.\d{1,3}){3}$/;

function isIpLiteral(host: string): boolean {
  return IPV4_LITERAL.test(host) || host.includes(":");
}

/**
 * Canonical form of a hostname for policy matching, or `null` when the value
 * cannot be a host at all. Lowercases, strips one pair of IPv6 brackets,
 * removes *all* trailing root dots, punycodes non-ASCII names, and refuses
 * anything carrying a port, path, credentials, whitespace or empty label.
 */
export function normalizeHostname(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  let host = raw.trim().toLowerCase();
  if (!host) return null;
  // URL.hostname keeps the brackets on IPv6 literals; the address is what the
  // policy cares about, so drop them here rather than at every call site.
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  host = host.replace(/\.+$/, "");
  if (!host) return null;
  if (host.includes("..")) return null;
  // IPv6 literals are not DNS names and are compared verbatim.
  if (host.includes(":") && IPV6_CHARS.test(host)) return host;
  if (ASCII_HOST.test(host)) return host;
  // Non-ASCII: a hostname never contains whitespace, a slash, '@' or a query, so
  // reject those before handing the value to the IDNA mapper.
  if (/[\s/@?#]/.test(host)) return null;
  // Punycode it. `domainToASCII` returns "" for anything unmappable, which is
  // exactly the answer we want — it can never match a policy entry.
  const ascii = domainToASCII(host);
  if (!ascii) return null;
  const normalized = ascii.replace(/\.+$/, "");
  return ASCII_HOST.test(normalized) ? normalized : null;
}

/**
 * Normalise one operator allowlist/deny-list entry. Returns a typed failure
 * rather than silently dropping a line, so a malformed entry is visible instead
 * of quietly widening the policy.
 */
export function normalizeDomainPattern(raw: string): NormalizedPattern | InvalidPattern {
  if (typeof raw !== "string") return { ok: false, detail: "entry is not a string" };
  const entry = raw.trim();
  if (!entry) return { ok: false, detail: "empty entry" };
  const lowered = entry.toLowerCase();
  if (lowered.includes("/") || lowered.includes("@") || lowered.includes("?") || lowered.includes("#")) {
    return { ok: false, detail: `'${entry}' is a URL, not a bare hostname` };
  }
  if (lowered.includes(":") && !lowered.startsWith("[")) {
    return { ok: false, detail: `'${entry}' includes a port; entries are hostnames only` };
  }
  let wildcard = false;
  let body = lowered;
  if (body.startsWith("*.")) {
    wildcard = true;
    body = body.slice(2);
  }
  if (body.includes("*")) {
    return { ok: false, detail: `'${entry}' may only use a single leading '*.' wildcard` };
  }
  const host = normalizeHostname(body);
  if (!host) return { ok: false, detail: `'${entry}' is not a valid hostname` };
  // A single label (`com`, `localhost`) is never a public research source, and
  // allowlisting one would open far more than the operator intended.
  if (!isIpLiteral(host) && !host.includes(".")) {
    return { ok: false, detail: `'${entry}' must be a fully-qualified domain` };
  }
  return { ok: true, pattern: wildcard ? `*.${host}` : host, wildcard };
}

/** Normalise a list, de-duplicating and reporting every unusable entry. */
export function normalizeDomainPatterns(entries: readonly string[]): {
  patterns: string[];
  invalid: Array<{ entry: string; detail: string }>;
} {
  const patterns: string[] = [];
  const invalid: Array<{ entry: string; detail: string }> = [];
  for (const entry of entries) {
    const normalized = normalizeDomainPattern(entry);
    if (normalized.ok) {
      if (!patterns.includes(normalized.pattern)) patterns.push(normalized.pattern);
    } else {
      invalid.push({ entry, detail: normalized.detail });
    }
  }
  return { patterns, invalid };
}

function patternBase(pattern: string, wildcard: boolean): string {
  return wildcard ? pattern.slice(2) : pattern;
}

/**
 * Label-boundary match: the host IS the entry, or is a subdomain of it. The
 * leading `.` in `endsWith("." + base)` is what makes `notcoingecko.com` fail to
 * match `coingecko.com`. A wildcard entry covers the apex and its subdomains
 * too, so `*.example.com` and `example.com` admit the same set — the wildcard is
 * documented as a wildcard, not as a mysterious no-op.
 */
export function hostMatchesDomain(rawHost: string, rawPattern: string): boolean {
  const host = normalizeHostname(rawHost);
  if (!host) return false;
  const normalized = normalizeDomainPattern(rawPattern);
  if (!normalized.ok) return false;
  const base = patternBase(normalized.pattern, normalized.wildcard);
  if (isIpLiteral(base)) return host === base;
  return host === base || host.endsWith(`.${base}`);
}

/**
 * True when every host admitted by `child` is also admitted by `parent`. Used to
 * compose a request-scoped allowlist with the operator's without ever widening
 * it: anything not provably a subset is discarded.
 */
export function patternSubsetOf(child: string, parent: string): boolean {
  const normalizedChild = normalizeDomainPattern(child);
  const normalizedParent = normalizeDomainPattern(parent);
  if (!normalizedChild.ok || !normalizedParent.ok) return false;
  const c = patternBase(normalizedChild.pattern, normalizedChild.wildcard);
  const p = patternBase(normalizedParent.pattern, normalizedParent.wildcard);
  return c === p || c.endsWith(`.${p}`);
}

/**
 * The allowlist check itself. An empty allowlist means "unrestricted", which
 * keeps the optional-allowlist contract in `.env.example`; a *present but
 * entirely unusable* allowlist is refused, because silently ignoring it would
 * turn a typo into an open gateway.
 */
export function checkDomainAllowlist(rawUrl: string, allow: readonly string[]): AllowlistVerdict {
  let host: string | null;
  try {
    host = normalizeHostname(new URL(rawUrl).hostname);
  } catch {
    return { allowed: false, reason: "malformed", detail: "not a parseable URL" };
  }
  if (!host) return { allowed: false, reason: "malformed", detail: "URL has no usable hostname" };

  const { patterns, invalid } = normalizeDomainPatterns(allow);
  if (patterns.length === 0) {
    if (invalid.length > 0) {
      const first = invalid[0]!;
      return {
        allowed: false,
        reason: "pattern_invalid",
        detail: `no usable allowlist entries (${invalid.length} invalid; first: '${first.entry}' — ${first.detail})`,
      };
    }
    return { allowed: true };
  }

  const matched = patterns.find((pattern) => hostMatchesDomain(host, pattern));
  if (!matched) {
    return {
      allowed: false,
      reason: "not_allowlisted",
      detail: `'${host}' is not on the research-domain allowlist`,
    };
  }
  return { allowed: true, matched };
}
