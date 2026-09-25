/**
 * SSRF defence for the Research Gateway.
 *
 * Agents pick the URLs they fetch, and those URLs come from LLM output derived
 * from web pages. That makes every fetch attacker-influenced, so the gateway is
 * the trust boundary between "an agent asked for a page" and "our server made a
 * request from inside the network".
 *
 * The dangerous requests are not exotic:
 *   - http://169.254.169.254/  cloud instance metadata → credentials
 *   - http://localhost:3000/    our own API, from inside, with no auth hop
 *   - http://10.0.0.5/          anything else in the VPC
 *   - file:///etc/passwd        local files
 *   - a public host that RESOLVES to a private address (DNS rebinding)
 *   - a public URL that REDIRECTS to one of the above
 *
 * The last two are why an allowlist alone is insufficient and why the resolved
 * IP must be checked, at every hop, immediately before connecting.
 */

import {
  checkDomainAllowlist,
  hostMatchesDomain,
  normalizeDomainPatterns,
  normalizeHostname,
  patternSubsetOf,
} from "./allowlist";

/** Only these two schemes can ever be fetched. */
const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

/** Hostnames that must never be resolved, let alone connected to. */
const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "ip6-loopback",
  // AWS/GCP/Azure instance metadata, including the DNS aliases.
  "metadata",
  "metadata.google.internal",
  "metadata.goog",
  "instance-data",
]);

/** Suffixes that resolve inside a private network by convention. */
const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".intranet", ".lan", ".home.arpa"];

export type SsrfReason =
  | "protocol"
  | "hostname"
  | "private_ip"
  | "credentials"
  | "port"
  | "malformed"
  | "protocol_downgrade"
  | "cross_domain"
  /** Valid public host, but the research-domain allowlist does not admit it. */
  | "not_allowlisted";

export interface UrlVerdict {
  allowed: boolean;
  reason?: SsrfReason;
  detail?: string;
}

const ALLOW = { allowed: true } as const;

function deny(reason: SsrfReason, detail: string): UrlVerdict {
  return { allowed: false, reason, detail };
}

/**
 * Ports worth allowing. Blocking everything else stops the gateway being used to
 * probe internal services (Redis on 6379, Postgres on 5432, …) for open ports.
 */
const ALLOWED_PORTS = new Set(["", "80", "443", "8080", "8443"]);

// ── IP literal classification ─────────────────────────────────────────────────

function ipv4ToParts(host: string): number[] | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  return parts.every((n) => n >= 0 && n <= 255) ? parts : null;
}

/** True for loopback, private, link-local, CGNAT, multicast and reserved space. */
export function isPrivateIpv4(host: string): boolean {
  const parts = ipv4ToParts(host);
  if (!parts) return false;
  const [a, b] = parts;
  if (a === 0) return true; // "this network"
  if (a === 10) return true; // private
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local, incl. 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 192 && b === 0) return true; // IETF protocol assignments
  if (a >= 224) return true; // multicast + reserved
  return false;
}

/** True for IPv6 loopback, link-local, unique-local and IPv4-mapped privates. */
export function isPrivateIpv6(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "::1" || normalized === "::") return true;
  if (/^fe[89ab][0-9a-f]:/.test(normalized)) return true; // link-local fe80::/10
  if (/^f[cd][0-9a-f]{2}:/.test(normalized)) return true; // unique-local fc00::/7
  // IPv4-mapped, e.g. ::ffff:127.0.0.1
  const mapped = /::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(normalized);
  if (mapped) return isPrivateIpv4(mapped[1]);
  return false;
}

export function isPrivateAddress(host: string): boolean {
  return isPrivateIpv4(host) || isPrivateIpv6(host);
}

// ── URL-level checks ──────────────────────────────────────────────────────────

/**
 * Static checks on a URL, before any DNS lookup. Cheap, and rejects the
 * overwhelming majority of hostile input.
 */
export function checkUrl(raw: string): UrlVerdict {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return deny("malformed", "not a parseable URL");
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    return deny("protocol", `scheme '${url.protocol}' is not fetchable`);
  }
  // Credentials in a URL are a redirect-laundering trick and never legitimate
  // for a public source.
  if (url.username || url.password) {
    return deny("credentials", "URL carries credentials");
  }
  if (!ALLOWED_PORTS.has(url.port)) {
    return deny("port", `port '${url.port}' is not allowed`);
  }

  const host = url.hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(host)) return deny("hostname", `'${host}' is blocked`);
  if (BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    return deny("hostname", `'${host}' resolves inside the network`);
  }
  if (isPrivateAddress(host)) {
    return deny("private_ip", `'${host}' is a private address`);
  }

  return ALLOW;
}

/**
 * Post-DNS check. `checkUrl` cannot catch a public hostname whose A record points
 * at 127.0.0.1 or 169.254.169.254 — that is DNS rebinding, and it is why the
 * resolved addresses must be validated too.
 *
 * ALL resolved addresses must be public: one private answer among several is
 * enough for an attacker, since which address gets used is not ours to choose.
 */
export function checkResolvedAddresses(addresses: string[]): UrlVerdict {
  if (addresses.length === 0) return deny("malformed", "host did not resolve");
  for (const address of addresses) {
    if (isPrivateAddress(address)) {
      return deny("private_ip", `host resolves to private address ${address}`);
    }
  }
  return ALLOW;
}

// ── Domain policy ─────────────────────────────────────────────────────────────

export interface DomainPolicy {
  /** When non-empty, ONLY these domains (and subdomains) may be fetched. */
  allow: string[];
  /** Always refused, even if the allowlist would permit them. */
  deny: string[];
  /**
   * When true, nothing is fetchable regardless of `allow`. Set when the
   * intersection of the operator and request-scoped allowlists is empty, so the
   * empty-list-means-unrestricted convention cannot be abused to widen policy.
   */
  denyAll?: boolean;
  /** When false, redirect hops cannot change origins/domains. Defaults to true. */
  allowCrossDomainRedirects?: boolean;
  /** When true (default), redirects cannot downgrade from https to http. */
  disallowProtocolDowngrade?: boolean;
  /** Maximum redirect hops allowed. Defaults to 3. */
  maxRedirects?: number;
}

/**
 * Normalised, label-boundary host match. Delegates to the allowlist module so
 * that the same trailing-dot / punycode / lookalike rules apply to both the
 * allow and the deny side of the policy.
 */
function hostMatches(host: string, pattern: string): boolean {
  return hostMatchesDomain(host, pattern);
}

/**
 * Apply the operator's domain policy. Deny wins over allow: an explicit block
 * must not be overridable by a broad allow entry.
 */
export function checkDomainPolicy(raw: string, policy: DomainPolicy): UrlVerdict {
  let host: string | null;
  try {
    host = normalizeHostname(new URL(raw).hostname);
  } catch {
    return deny("malformed", "not a parseable URL");
  }
  if (!host) return deny("malformed", "URL has no usable hostname");

  if (policy.denyAll) {
    return deny("not_allowlisted", "no domain satisfies every applicable allowlist");
  }
  if (policy.deny.some((pattern) => hostMatches(host, pattern))) {
    return deny("hostname", `'${host}' is on the deny list`);
  }
  if (policy.allow.length > 0) {
    // The allowlist also validates its own entries: a configured-but-unusable
    // list is a refusal, not an invitation to fetch anything.
    const verdict = checkDomainAllowlist(raw, policy.allow);
    if (!verdict.allowed) {
      return deny(verdict.reason === "pattern_invalid" ? "hostname" : "not_allowlisted", verdict.detail ?? `'${host}' is not on the allow list`);
    }
  }
  return ALLOW;
}

/**
 * Validate a redirect transition from currentUrl to targetUrl according to policy rules:
 * 1. Target URL format & scheme validity.
 * 2. Insecure protocol downgrade prevention (https -> http).
 * 3. Cross-domain redirect boundary checks.
 * 4. Target domain allowlist/denylist policy.
 */
export function checkRedirectHopPolicy(
  currentUrl: string,
  targetUrl: string,
  policy: DomainPolicy = { allow: [], deny: [] },
): UrlVerdict {
  let curr: URL;
  let target: URL;
  try {
    curr = new URL(currentUrl);
    target = new URL(targetUrl, currentUrl);
  } catch {
    return deny("malformed", "not a parseable redirect URL");
  }

  // Static checks on target URL first (SSRF, blocked hosts, private IPs, credentials, ports)
  const staticVerdict = checkUrl(target.toString());
  if (!staticVerdict.allowed) {
    return staticVerdict;
  }

  // Protocol downgrade check (e.g., https: -> http:)
  const disallowDowngrade = policy.disallowProtocolDowngrade ?? true;
  if (disallowDowngrade && curr.protocol === "https:" && target.protocol === "http:") {
    return deny("protocol_downgrade", "redirect downgrades protocol from https to http");
  }

  // Cross-domain redirect constraint
  const allowCrossDomain = policy.allowCrossDomainRedirects ?? true;
  if (!allowCrossDomain) {
    // Normalise before comparing: `example.com.` is the same origin as
    // `example.com`, and a trailing root dot must not read as "different host".
    const currHost = normalizeHostname(curr.hostname) ?? curr.hostname.toLowerCase();
    const targetHost = normalizeHostname(target.hostname) ?? target.hostname.toLowerCase();
    if (currHost !== targetHost && !targetHost.endsWith(`.${currHost}`)) {
      return deny("cross_domain", `cross-domain redirect from '${currHost}' to '${targetHost}' is not allowed`);
    }
  }

  // Domain policy check on target URL
  return checkDomainPolicy(target.toString(), policy);
}

const SENSITIVE_HEADERS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "proxy-authorization",
  "x-api-key",
  "x-auth-token",
  "x-cg-demo-api-key",
  "x-stellar-account",
  "x-wallet-address",
  "x-agent-signature",
  "x-spend-permission",
]);

/**
 * Sanitize request headers across redirect hops. When crossing origin boundaries,
 * sensitive credentials, cookies, and tokens are scrubbed to prevent leaking
 * private authentication or wallet context to third parties.
 */
export function sanitizeHeadersForRedirect(
  headers: Record<string, string>,
  currentUrl: string,
  targetUrl: string,
): Record<string, string> {
  let currOrigin: string;
  let targetOrigin: string;
  try {
    currOrigin = new URL(currentUrl).origin;
    targetOrigin = new URL(targetUrl, currentUrl).origin;
  } catch {
    return {};
  }

  const result: Record<string, string> = {};
  const isSameOrigin = currOrigin.toLowerCase() === targetOrigin.toLowerCase();

  for (const [key, value] of Object.entries(headers)) {
    const lowerKey = key.toLowerCase();
    if (!isSameOrigin && SENSITIVE_HEADERS.has(lowerKey)) {
      continue;
    }
    result[key] = value;
  }
  return result;
}

/**
 * Parse a comma-separated env value into a normalised domain list. Entries that
 * are not usable hostnames are dropped here and surfaced by
 * `domainPolicyDiagnostics`, so a typo cannot silently widen the policy.
 */
export function parseDomainList(raw: string | undefined): string[] {
  const entries = (raw ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return normalizeDomainPatterns(entries).patterns;
}

/**
 * Reads the operator policy. The parameter is a plain record rather than
 * NodeJS.ProcessEnv so tests can pass just the keys that matter.
 */
export function domainPolicyFromEnv(
  env: Record<string, string | undefined> = process.env,
): DomainPolicy {
  const allowCrossDomain = env.RESEARCH_ALLOW_CROSS_DOMAIN_REDIRECTS !== undefined
    ? env.RESEARCH_ALLOW_CROSS_DOMAIN_REDIRECTS !== "0" && env.RESEARCH_ALLOW_CROSS_DOMAIN_REDIRECTS.toLowerCase() !== "false"
    : true;
  const disallowProtocolDowngrade = env.RESEARCH_ALLOW_PROTOCOL_DOWNGRADE !== undefined
    ? env.RESEARCH_ALLOW_PROTOCOL_DOWNGRADE === "0" || env.RESEARCH_ALLOW_PROTOCOL_DOWNGRADE.toLowerCase() === "false"
    : true;
  const parsedMax = env.RESEARCH_MAX_REDIRECTS ? Number.parseInt(env.RESEARCH_MAX_REDIRECTS, 10) : undefined;
  const maxRedirects = parsedMax !== undefined && !Number.isNaN(parsedMax) && parsedMax >= 0 ? Math.min(parsedMax, 10) : undefined;

  return {
    allow: parseDomainList(env.RESEARCH_ALLOWED_DOMAINS),
    deny: parseDomainList(env.RESEARCH_DENIED_DOMAINS),
    allowCrossDomainRedirects: allowCrossDomain,
    disallowProtocolDowngrade,
    maxRedirects,
  };
}

/**
 * What the operator's raw config actually contained.
 *
 * `domainPolicyFromEnv` normalises silently, so invalid entries vanish. Without
 * this, `RESEARCH_ALLOWED_DOMAINS=https://coingecko.com` becomes "no allowlist →
 * unrestricted", which is the opposite of what the operator asked for. The
 * gateway uses this to fail closed on a configured-but-unusable allowlist.
 */
export interface DomainPolicyDiagnostics {
  allowConfigured: boolean;
  allowInvalid: Array<{ entry: string; detail: string }>;
  denyConfigured: boolean;
  denyInvalid: Array<{ entry: string; detail: string }>;
}

function rawEntries(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function domainPolicyDiagnostics(
  env: Record<string, string | undefined> = process.env,
): DomainPolicyDiagnostics {
  const allowEntries = rawEntries(env.RESEARCH_ALLOWED_DOMAINS);
  const denyEntries = rawEntries(env.RESEARCH_DENIED_DOMAINS);
  return {
    allowConfigured: allowEntries.length > 0,
    allowInvalid: normalizeDomainPatterns(allowEntries).invalid,
    denyConfigured: denyEntries.length > 0,
    denyInvalid: normalizeDomainPatterns(denyEntries).invalid,
  };
}

function minDefined(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.min(a, b);
}

/**
 * Compose the operator policy with a request-scoped one.
 *
 * The request-scoped policy may only ever NARROW the operator's:
 *
 *   - allow: an entry survives only when it is provably a subset of an operator
 *     entry, so `{ allow: ["evil.com"] }` cannot add a domain. When the
 *     intersection is empty, `denyAll` is set — essential, because an empty
 *     allowlist otherwise means "unrestricted".
 *   - deny: unioned.
 *   - cross-domain redirects: allowed only when both sides allow them.
 *   - protocol downgrade: disallowed when either side disallows it.
 *   - maxRedirects: the smaller ceiling.
 */
export function composeDomainPolicy(operator: DomainPolicy, caller?: DomainPolicy): DomainPolicy {
  const operatorAllow = normalizeDomainPatterns(operator.allow).patterns;
  const callerAllow = normalizeDomainPatterns(caller?.allow ?? []).patterns;

  let allow: string[];
  let denyAll = false;
  if (operatorAllow.length === 0) {
    allow = callerAllow;
  } else if (callerAllow.length === 0) {
    allow = operatorAllow;
  } else {
    allow = callerAllow.filter((entry) =>
      operatorAllow.some((operatorEntry) => patternSubsetOf(entry, operatorEntry)),
    );
    // Nothing the caller asked for is inside the operator allowlist: refuse
    // everything rather than fall back to the empty-means-unrestricted default.
    denyAll = allow.length === 0;
  }

  const deny = [
    ...new Set([
      ...normalizeDomainPatterns(operator.deny).patterns,
      ...normalizeDomainPatterns(caller?.deny ?? []).patterns,
    ]),
  ];

  return {
    allow,
    deny,
    ...(denyAll ? { denyAll: true } : {}),
    allowCrossDomainRedirects:
      (operator.allowCrossDomainRedirects ?? true) && (caller?.allowCrossDomainRedirects ?? true),
    disallowProtocolDowngrade:
      (operator.disallowProtocolDowngrade ?? true) || (caller?.disallowProtocolDowngrade ?? true),
    maxRedirects: minDefined(operator.maxRedirects, caller?.maxRedirects),
  };
}
