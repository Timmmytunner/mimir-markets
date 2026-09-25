/**
 * Shared evidence fetcher for Mimir.
 *
 * Used by:
 *   - lib/server/source-claim-generator.ts (drafts: helps users propose claims)
 *   - agents/oracle/index.ts (resolution: settles expired claims on-chain)
 *
 * Strategy:
 *   1. Host-routed handlers for sources with clean public APIs (deterministic,
 *      LLM-friendly snapshots). Today: CoinGecko.
 *   2. For everything else: direct fetch first. If we hit a Cloudflare
 *      "verify you're human" interstitial or a forbidden response, fall back
 *      to Jina Reader (https://r.jina.ai/URL) which renders the page via a
 *      managed browser farm and returns markdown.
 *
 * The returned snapshot's `fetcher` field tells callers where the text came
 * from so they can adjust trust (e.g. oracle downgrades confidence when the
 * evidence came via Jina rather than a structured API).
 */

import { checkRedirectHopPolicy, domainPolicyFromEnv } from "@/lib/research/ssrf";
import { validateHop } from "@/lib/research/gateway";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_CHARS = 14_000;
const COINGECKO_API_BASE = "https://api.coingecko.com/api/v3";
const JINA_READER_BASE = "https://r.jina.ai/";

// Markers that strongly suggest we got an anti-bot interstitial instead of
// actual content. Keep this list conservative — false positives mean we
// uselessly burn a Jina fallback call.
const CLOUDFLARE_MARKERS = [
  "verifying you are human",
  "needs to review the security of your connection",
  "just a moment",
  "challenges.cloudflare.com",
  "cf-browser-verification",
  "__cf_chl_",
  "attention required! | cloudflare",
] as const;

export type EvidenceFetcherKind = "coingecko-api" | "direct" | "jina" | "bot-paid";

/** What the agent paid to obtain a paywalled evidence source. */
export interface EvidencePayment {
  /** Price in USDC atomic units (7dp — see lib/usdc.ts). */
  priceUnits: string;
  /** On-chain transfer hash proving the payment. */
  txHash: string;
}

/** Budgeted paying fetch injected by the caller (oracle wires lib/x402/buyer). */
export type PaidFetch = (
  url: string,
  init?: RequestInit,
) => Promise<{ response: Response; payment: EvidencePayment | null }>;

export interface EvidenceSnapshot {
  /** Normalized final URL (after redirects when applicable). */
  sourceUrl: string;
  /** Best-effort page title; empty string when unavailable. */
  title: string;
  /** Plain text suitable for LLM consumption. Already truncated to maxChars. */
  text: string;
  /** ms epoch when the fetch completed. */
  fetchedAt: number;
  /** Which path produced this snapshot. Callers can use this to gate trust. */
  fetcher: EvidenceFetcherKind;
  /** Set when the source was paywalled and the agent paid in USDC. */
  payment?: EvidencePayment;
}

export class EvidenceFetchError extends Error {
  constructor(message: string, readonly statusCode?: number) {
    super(message);
    this.name = "EvidenceFetchError";
  }
}

export interface FetchEvidenceOptions {
  /** Override the per-request char cap. Defaults to 14k. */
  maxChars?: number;
  /** Custom User-Agent for direct fetches. */
  userAgent?: string;
  /** Total request timeout in ms. Defaults to 15s. */
  timeoutMs?: number;
  /** When true, skip the Jina fallback and let direct failures bubble up. */
  disableJinaFallback?: boolean;
  /**
   * When set, a 402 Payment Required from the source is paid via this budgeted
   * fetch (x402 USDC payment) instead of failing. The caller owns the budget cap
   * and the paying wallet — see lib/x402/buyer.ts fetchWithBudget. Absent → 402 behaves
   * like any other error (falls through to Jina / failure).
   */
  paidFetch?: PaidFetch;
}

export async function fetchEvidence(
  rawUrl: string,
  opts: FetchEvidenceOptions = {},
): Promise<EvidenceSnapshot> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new EvidenceFetchError("Invalid URL");
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new EvidenceFetchError("Unsupported URL protocol");
  }

  // SSRF guard. The URL reaching here is attacker-chosen in both callers: a claim's
  // resolutionUrl is whatever the creator wrote on chain, and the draft route takes
  // one straight from a request body. Without this the oracle — the process holding
  // every agent key — could be pointed at cloud metadata or a neighbour service and
  // would echo what it read into the public resolution summary.
  const hop = await validateHop(parsed.toString(), domainPolicyFromEnv());
  if (!hop.allowed) {
    throw new EvidenceFetchError(`Refused to fetch this URL (${hop.reason})`);
  }

  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");

  if (host === "coingecko.com") {
    const snap = await fetchCoinGeckoSnapshot(parsed, opts);
    if (snap) return snap;
    // Fall through if the URL didn't match a known CoinGecko shape.
  }

  return fetchGenericSnapshot(parsed, opts);
}

// ── Generic path: direct fetch, then Jina fallback ────────────────────────

async function fetchGenericSnapshot(
  url: URL,
  opts: FetchEvidenceOptions,
): Promise<EvidenceSnapshot> {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const userAgent = opts.userAgent ?? "Mimir-Bot/1.0 (+https://mimir.app)";

  const direct = await tryDirectFetch(url, { timeoutMs, userAgent });

  // Paywalled source: the agent pays the x402 USDC nanopayment and re-fetches.
  if (direct.statusCode === 402 && opts.paidFetch) {
    const paid = await fetchViaHttp402(url, opts.paidFetch, { maxChars });
    if (paid) return paid;
    // Payment declined (over budget) or unparseable — fall through to failure.
  }

  if (direct.ok && !looksLikeCloudflareInterstitial(direct.body)) {
    const text = stripHtml(direct.body).slice(0, maxChars);
    if (text.length >= 200) {
      return {
        sourceUrl: direct.finalUrl,
        title: extractTitle(direct.body),
        text,
        fetchedAt: Date.now(),
        fetcher: "direct",
      };
    }
    // Body parsed but is too short to be useful — fall through to Jina.
  }

  if (opts.disableJinaFallback) {
    throw new EvidenceFetchError(
      direct.ok
        ? "Source returned a bot-protection page"
        : `Unable to fetch source (${direct.statusCode ?? "network error"})`,
      direct.statusCode,
    );
  }

  const jina = await fetchViaJina(url, { timeoutMs, maxChars });
  return jina;
}

interface DirectFetchResult {
  ok: boolean;
  body: string;
  finalUrl: string;
  statusCode?: number;
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/** A public host that 302s to 169.254.169.254 defeats an entry-only check. */
const MAX_REDIRECTS = 5;

async function tryDirectFetch(
  url: URL,
  args: { timeoutMs: number; userAgent: string },
): Promise<DirectFetchResult> {
  let finalUrl = url.toString();
  const visitedUrls = new Set<string>([finalUrl.toLowerCase()]);
  const policy = domainPolicyFromEnv();

  try {
    let response = await fetch(finalUrl, {
      method: "GET",
      headers: {
        "User-Agent": args.userAgent,
        Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.8",
      },
      cache: "no-store",
      // Manual, so every hop is validated the way the first one was. `follow`
      // would let the redirect chain reach an address the guard just refused.
      redirect: "manual",
      signal: AbortSignal.timeout(args.timeoutMs),
    });

    for (let hops = 0; isRedirect(response.status) && hops < MAX_REDIRECTS; hops++) {
      const location = response.headers.get("location");
      if (!location || location.trim() === "") break;
      let next: URL;
      try {
        next = new URL(location.trim(), finalUrl);
      } catch {
        return { ok: false, body: "", finalUrl, statusCode: response.status };
      }
      if (next.protocol !== "https:" && next.protocol !== "http:") {
        return { ok: false, body: "", finalUrl, statusCode: response.status };
      }

      const redirectHop = checkRedirectHopPolicy(finalUrl, next.toString(), policy);
      if (!redirectHop.allowed) {
        return { ok: false, body: "", finalUrl, statusCode: response.status };
      }

      const normNext = next.toString().toLowerCase();
      if (visitedUrls.has(normNext)) {
        return { ok: false, body: "", finalUrl, statusCode: response.status };
      }
      visitedUrls.add(normNext);

      const hop = await validateHop(next.toString(), policy);
      if (!hop.allowed) {
        return { ok: false, body: "", finalUrl, statusCode: response.status };
      }
      finalUrl = next.toString();
      response = await fetch(finalUrl, {
        method: "GET",
        headers: {
          "User-Agent": args.userAgent,
          Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.8",
        },
        cache: "no-store",
        redirect: "manual",
        signal: AbortSignal.timeout(args.timeoutMs),
      });
    }

    if (isRedirect(response.status)) {
      return { ok: false, body: "", finalUrl, statusCode: response.status };
    }

    const contentType = response.headers.get("content-type") || "";
    const isTexty = /text\/html|application\/xhtml\+xml|text\/plain|application\/json/i.test(contentType);

    if (!response.ok) {
      return { ok: false, body: "", finalUrl: response.url || finalUrl, statusCode: response.status };
    }
    if (!isTexty) {
      return { ok: false, body: "", finalUrl: response.url || finalUrl, statusCode: response.status };
    }

    const body = await response.text();
    return { ok: true, body, finalUrl: response.url || finalUrl, statusCode: response.status };
  } catch {
    return { ok: false, body: "", finalUrl };
  }
}

// ── HTTP 402 paid path ─────────────────────────────────────────────────────
// Hit when a source replies 402 and the caller supplied a budgeted paying fetch.
// Returns null (not throw) when payment was declined or yielded no usable body,
// so the generic path can fall through to its normal failure handling.
async function fetchViaHttp402(
  url: URL,
  paidFetch: PaidFetch,
  args: { maxChars: number },
): Promise<EvidenceSnapshot | null> {
  let paid: { response: Response; payment: EvidencePayment | null };
  try {
    paid = await paidFetch(url.toString());
  } catch {
    return null; // PaymentBudgetExceeded or network error — agent walked away
  }
  if (!paid.response.ok) return null;

  const raw = await paid.response.text();
  const contentType = paid.response.headers.get("content-type") || "";
  const text = (/(html|xml)/i.test(contentType) ? stripHtml(raw) : raw)
    .trim()
    .slice(0, args.maxChars);
  if (text.length < 1) return null;

  return {
    sourceUrl: url.toString(),
    title: /(html|xml)/i.test(contentType) ? extractTitle(raw) : "",
    text,
    fetchedAt: Date.now(),
    fetcher: "bot-paid",
    ...(paid.payment ? { payment: paid.payment } : {}),
  };
}

async function fetchViaJina(
  url: URL,
  args: { timeoutMs: number; maxChars: number },
): Promise<EvidenceSnapshot> {
  const jinaUrl = `${JINA_READER_BASE}${url.toString()}`;
  let response: Response;
  try {
    response = await fetch(jinaUrl, {
      method: "GET",
      headers: {
        Accept: "text/plain",
        "X-Return-Format": "markdown",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(args.timeoutMs),
    });
  } catch (err: any) {
    throw new EvidenceFetchError(
      `Jina fallback failed: ${err?.message ?? "network error"}`,
    );
  }

  if (!response.ok) {
    throw new EvidenceFetchError(
      `Jina fallback failed (${response.status})`,
      response.status,
    );
  }

  const raw = await response.text();
  // Jina returns markdown; first non-empty heading line is a decent title.
  const title = extractJinaTitle(raw);
  const text = raw.replace(/\s+\n/g, "\n").trim().slice(0, args.maxChars);

  if (text.length < 200) {
    throw new EvidenceFetchError("Jina returned too little content to use");
  }

  return {
    sourceUrl: url.toString(),
    title,
    text,
    fetchedAt: Date.now(),
    fetcher: "jina",
  };
}

// ── CoinGecko handler ─────────────────────────────────────────────────────

const COINGECKO_COIN_PATH = /\/coins\/([^/?#]+)/i;

async function fetchCoinGeckoSnapshot(
  url: URL,
  opts: FetchEvidenceOptions,
): Promise<EvidenceSnapshot | null> {
  const match = url.pathname.match(COINGECKO_COIN_PATH);
  if (!match) return null;
  const coinId = decodeURIComponent(match[1]).toLowerCase().trim();
  if (!coinId || !/^[a-z0-9-]+$/.test(coinId)) return null;

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const apiKey = process.env.COINGECKO_API_KEY?.trim();

  const params = new URLSearchParams({
    localization: "false",
    tickers: "false",
    market_data: "true",
    community_data: "false",
    developer_data: "false",
    sparkline: "false",
  });

  const headers: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": "Mimir-Bot/1.0 (+https://mimir.app)",
  };
  if (apiKey) headers["x-cg-demo-api-key"] = apiKey;

  let response: Response;
  try {
    response = await fetch(`${COINGECKO_API_BASE}/coins/${encodeURIComponent(coinId)}?${params}`, {
      method: "GET",
      headers,
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return null; // network error — let caller fall back to generic path
  }

  if (!response.ok) {
    // 404 = bad slug; 429 = rate-limited. Either way, fall back.
    return null;
  }

  let payload: any;
  try {
    payload = await response.json();
  } catch {
    return null;
  }

  if (!payload || typeof payload !== "object") return null;
  const name = String(payload.name ?? coinId);
  const symbol = String(payload.symbol ?? "").toUpperCase();
  const md = payload.market_data;
  if (!md || typeof md !== "object") return null;

  const lines: string[] = [];
  lines.push(`CoinGecko snapshot — ${name}${symbol ? ` (${symbol})` : ""}`);
  lines.push(`Source: ${url.toString()}`);
  if (payload.last_updated) lines.push(`Last updated: ${payload.last_updated}`);
  lines.push("");

  const usd = (v: any) => (typeof v?.usd === "number" ? v.usd : null);
  const fields: Array<[string, number | null]> = [
    ["current_price_usd", usd(md.current_price)],
    ["market_cap_usd", usd(md.market_cap)],
    ["total_volume_24h_usd", usd(md.total_volume)],
    ["high_24h_usd", usd(md.high_24h)],
    ["low_24h_usd", usd(md.low_24h)],
    ["price_change_pct_24h", typeof md.price_change_percentage_24h === "number" ? md.price_change_percentage_24h : null],
    ["price_change_pct_7d", typeof md.price_change_percentage_7d === "number" ? md.price_change_percentage_7d : null],
    ["price_change_pct_30d", typeof md.price_change_percentage_30d === "number" ? md.price_change_percentage_30d : null],
    ["circulating_supply", typeof md.circulating_supply === "number" ? md.circulating_supply : null],
    ["total_supply", typeof md.total_supply === "number" ? md.total_supply : null],
    ["ath_usd", usd(md.ath)],
    ["atl_usd", usd(md.atl)],
  ];
  for (const [key, value] of fields) {
    if (value !== null) lines.push(`${key}: ${value}`);
  }

  if (typeof payload.market_cap_rank === "number") {
    lines.push(`market_cap_rank: ${payload.market_cap_rank}`);
  }

  const text = lines.join("\n").slice(0, opts.maxChars ?? DEFAULT_MAX_CHARS);

  return {
    sourceUrl: url.toString(),
    title: `${name}${symbol ? ` (${symbol})` : ""} — CoinGecko`,
    text,
    fetchedAt: Date.now(),
    fetcher: "coingecko-api",
  };
}

// ── HTML helpers ──────────────────────────────────────────────────────────

function looksLikeCloudflareInterstitial(body: string): boolean {
  if (!body) return false;
  const lower = body.toLowerCase();
  // Short HTML bodies that mention CF challenge markers are the giveaway —
  // a real article rarely has both a tiny body AND these strings.
  if (lower.length > 50_000) return false;
  return CLOUDFLARE_MARKERS.some((marker) => lower.includes(marker));
}

function decodeEntities(input: string) {
  return input
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, value: string) => {
      const codePoint = Number(value);
      return Number.isFinite(codePoint) ? String.fromCharCode(codePoint) : "";
    });
}

function stripHtml(html: string): string {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

function extractTitle(html: string): string {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? decodeEntities(match[1]).trim() : "";
}

function extractJinaTitle(markdown: string): string {
  // Jina returns frontmatter-ish header lines: "Title: ...", "URL Source: ...".
  const titleLine = markdown.split("\n").find((line) => /^title:\s*/i.test(line));
  if (titleLine) return titleLine.replace(/^title:\s*/i, "").trim();
  const heading = markdown.split("\n").find((line) => /^#\s+/.test(line));
  return heading ? heading.replace(/^#\s+/, "").trim() : "";
}
