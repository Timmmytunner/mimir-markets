/**
 * Share card content model.
 *
 * Split from the renderer so the privacy rules are testable without rendering an
 * image. The rules that matter:
 *
 *  1. **A private market's card never reveals the claim.** The card URL carries
 *     only the public claim id, and a private claim renders a locked placeholder.
 *     Anyone can request /api/share/12 — an OG scraper does, by definition — so
 *     the card must be safe for someone holding no invite key.
 *  2. **The invite key is never in the URL, the image, or a cache key.** Share
 *     cards are cached by URL at the CDN; a key in the URL would be cached and
 *     logged by every hop.
 *  3. **A wallet address is never printed whole, and the zero-address sentinel
 *     never reaches the card.** A public card is scraped and cached by
 *     strangers, so a full address would tie a wallet to a market on a permanent
 *     public image. Addresses are shortened like everywhere else in the UI, and
 *     `ZERO_ADDRESS` (written for a claim with no challenger) falls back to a
 *     role label instead of printing as `0x0000…`.
 *  4. Long claims are truncated on a word boundary so the card never overflows,
 *     and the truncation is visible rather than silent.
 */

import { shortenAddress, ZERO_ADDRESS } from "./constants";
import type { CanonicalMode, SettlementMode } from "./market-modes";
import { SETTLEMENT_MODE_POLICY } from "./market-modes";

export type ShareCardKind = "market" | "settlement" | "duel" | "rematch";
export type ShareCardLocale = "en" | "tr";

/** Open Graph default plus the platform sizes the roadmap names. */
export const CARD_SIZES = {
  og: { width: 1200, height: 630 },
  x: { width: 1200, height: 675 },
  farcaster: { width: 1200, height: 800 },
} as const;

export type CardSize = keyof typeof CARD_SIZES;

export function isCardSize(value: string): value is CardSize {
  return value in CARD_SIZES;
}

export const MAX_CLAIM_CHARS = 140;
export const MAX_SIDE_CHARS = 48;

export interface ShareCardInput {
  claimId: number;
  question: string;
  creatorPosition: string;
  counterPosition: string;
  resolutionUrl: string;
  /** Display USDC. */
  totalPot: number;
  mode: CanonicalMode;
  deadline: number;
  state: "open" | "active" | "resolved" | "cancelled";
  isPrivate: boolean;
  winnerSide?: "creator" | "challengers" | "draw" | "unresolvable" | "";
  /** Display USDC paid to the winning side. */
  payout?: number;
  /** Rematch series position, when this claim is part of a ladder. */
  series?: { round: number; bestOf?: number; creatorWins: number; challengerWins: number };
  locale?: ShareCardLocale;
  creatorIdentity?: string;
  challengerIdentity?: string;
}

export interface ShareCard {
  kind: ShareCardKind;
  size: { width: number; height: number };
  /** Headline. For a private market this is a locked placeholder. */
  title: string;
  sideA: string;
  sideB: string;
  actorA: string;
  actorB: string;
  avatarFallbackA: string;
  avatarFallbackB: string;
  /** Registrable domain of the resolution source, or "" when withheld. */
  sourceDomain: string;
  potLabel: string;
  modeLabel: string;
  /** "Winner takes pot" for a duel, etc. Empty when not applicable. */
  economicsLabel: string;
  deadlineIso: string;
  verdictLabel: string;
  payoutLabel: string;
  seriesLabel: string;
  /** True when detail is withheld because the market is private. */
  locked: boolean;
}

function truncateOnWord(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  const glyphs = Array.from(clean);
  if (glyphs.length <= max) return clean;
  // Array.from slices Unicode code points, so a surrogate-pair emoji is never
  // cut into an invalid replacement character.
  const cut = glyphs.slice(0, max).join("");
  const lastSpace = cut.lastIndexOf(" ");
  // Truncation is visible, never silent.
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

const CARD_COPY = {
  en: {
    privateTitle: "Private claim on Mimir",
    inviteOnly: "Invite only",
    creator: "Creator",
    rival: "Open rival",
    challengers: "Challenger side",
    winnerTakes: "Winner takes the pot",
    fixedOdds: "Creator-backed fixed odds",
    poolPayout: "Proportional pool payout",
    cancelled: "Cancelled — stakes refunded",
    creatorWins: "Creator wins",
    rivalWins: "Rival wins",
    challengersWin: "Challengers win",
    draw: "Draw — refunded in full",
    unresolvable: "Unresolvable — refunded in full",
    settled: "Settled",
    paidOut: "USDC paid out",
    round: "Round",
    bestOf: "Best of",
  },
  tr: {
    privateTitle: "Mimir'de özel market",
    inviteOnly: "Yalnız davetle",
    creator: "Kurucu",
    rival: "Açık rakip",
    challengers: "Rakip tarafı",
    winnerTakes: "Kazanan potun tamamını alır",
    fixedOdds: "Kurucu teminatlı sabit oran",
    poolPayout: "Oransal havuz ödemesi",
    cancelled: "İptal — stake'ler iade edildi",
    creatorWins: "Kurucu kazandı",
    rivalWins: "Rakip kazandı",
    challengersWin: "Rakip tarafı kazandı",
    draw: "Berabere — tam iade",
    unresolvable: "Çözülemedi — tam iade",
    settled: "Sonuçlandı",
    paidOut: "USDC ödendi",
    round: "Tur",
    bestOf: "Seri",
  },
} as const;

/** Stellar strkeys are 56 base32 chars: `G…` for accounts, `C…` for contracts. */
const STELLAR_STRKEY = /^[GC][A-Z2-7]{55}$/;
/** A 20-byte EVM address in hex. */
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * True when a value names no participant at all: empty, the off-chain
 * `ZERO_ADDRESS` sentinel, or an all-zero address. `decodeClaim` writes
 * `ZERO_ADDRESS` when a claim has no challenger yet, so treating it as present
 * would print a literal zero address where a role label belongs.
 */
export function isAbsentIdentity(value: string | null | undefined): boolean {
  const clean = value?.trim() ?? "";
  return clean === "" || clean === ZERO_ADDRESS || /^0x0+$/i.test(clean);
}

/** True for a full wallet address, as opposed to a human display name. */
export function isWalletAddress(value: string): boolean {
  const clean = value.trim();
  return STELLAR_STRKEY.test(clean) || EVM_ADDRESS.test(clean);
}

/**
 * Resolve a participant label for a PUBLIC card.
 *
 * A wallet address is shortened rather than printed whole: the repo shortens
 * addresses everywhere else in the UI (`shortenAddress`), and a card is scraped
 * and cached by strangers, so the full address would tie a wallet to a market on
 * a permanent public image. A missing or zero address falls back to the role
 * label, never to the sentinel itself.
 */
export function resolveIdentity(value: string | null | undefined, fallback: string): string {
  const clean = value?.trim() ?? "";
  if (isAbsentIdentity(clean)) return fallback;
  return isWalletAddress(clean) ? shortenAddress(clean) : clean;
}

function avatarFallback(identity: string): string {
  const clean = identity.trim();
  if (!clean) return "?";
  if (/^0x[0-9a-f]+$/i.test(clean)) return "0x";
  const words = clean.split(/\s+/).filter(Boolean);
  return words.slice(0, 2).map((word) => Array.from(word)[0] ?? "").join("").toUpperCase() || "?";
}

export function shareCardDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function economicsLabel(mode: SettlementMode, locale: ShareCardLocale): string {
  const copy = CARD_COPY[locale];
  switch (mode) {
    case "duel":
      return copy.winnerTakes;
    case "fixed_odds":
      return copy.fixedOdds;
    case "pool":
      return copy.poolPayout;
    default:
      return "";
  }
}

function verdictLabel(input: ShareCardInput): string {
  const copy = CARD_COPY[input.locale ?? "en"];
  if (input.state === "cancelled") return copy.cancelled;
  if (input.state !== "resolved") return "";
  switch (input.winnerSide) {
    case "creator":
      return copy.creatorWins;
    case "challengers":
      return input.mode.settlementMode === "duel" ? copy.rivalWins : copy.challengersWin;
    case "draw":
      return copy.draw;
    case "unresolvable":
      return copy.unresolvable;
    default:
      return copy.settled;
  }
}

function seriesLabel(input: ShareCardInput): string {
  const series = input.series;
  if (!series) return "";
  const copy = CARD_COPY[input.locale ?? "en"];
  const score = `${series.creatorWins}–${series.challengerWins}`;
  if (series.bestOf) return `${copy.round} ${series.round} · ${copy.bestOf} ${series.bestOf} · ${score}`;
  return `${copy.round} ${series.round} · ${score}`;
}

function cardKind(input: ShareCardInput): ShareCardKind {
  if (input.series) return "rematch";
  if (input.state === "resolved" || input.state === "cancelled") return "settlement";
  if (input.mode.settlementMode === "duel") return "duel";
  return "market";
}

/**
 * Build the card content. Deterministic: the same claim state always produces the
 * same card, so the CDN can cache it and two viewers see the same thing.
 */
export function buildShareCard(input: ShareCardInput, size: CardSize = "og"): ShareCard {
  const dimensions = CARD_SIZES[size];
  const policy = SETTLEMENT_MODE_POLICY[input.mode.settlementMode];
  const locale = input.locale ?? "en";
  const copy = CARD_COPY[locale];

  // A private market's card is requested by scrapers and strangers, so it must
  // be safe for someone with no invite key: no question, no sides, no source.
  if (input.isPrivate) {
    return {
      kind: cardKind(input),
      size: dimensions,
      title: copy.privateTitle,
      sideA: copy.inviteOnly,
      sideB: copy.inviteOnly,
      actorA: copy.inviteOnly,
      actorB: copy.inviteOnly,
      avatarFallbackA: "?",
      avatarFallbackB: "?",
      sourceDomain: "",
      potLabel: "",
      modeLabel: policy?.label ?? "",
      economicsLabel: "",
      deadlineIso: "",
      verdictLabel: "",
      payoutLabel: "",
      seriesLabel: "",
      locked: true,
    };
  }

  // Identities go through one resolver so a wallet address is never printed
  // whole and the zero-address sentinel never reaches the card.
  const actorA = resolveIdentity(input.creatorIdentity, copy.creator);
  const actorB = resolveIdentity(
    input.challengerIdentity,
    input.mode.settlementMode === "duel" ? copy.rival : copy.challengers,
  );

  return {
    kind: cardKind(input),
    size: dimensions,
    title: truncateOnWord(input.question, MAX_CLAIM_CHARS),
    sideA: truncateOnWord(input.creatorPosition, MAX_SIDE_CHARS),
    sideB: truncateOnWord(input.counterPosition, MAX_SIDE_CHARS),
    actorA,
    actorB,
    avatarFallbackA: avatarFallback(actorA),
    avatarFallbackB: avatarFallback(actorB),
    sourceDomain: shareCardDomain(input.resolutionUrl),
    potLabel: `${formatPot(input.totalPot)} USDC`,
    modeLabel: policy?.label ?? "",
    economicsLabel: economicsLabel(input.mode.settlementMode, locale),
    deadlineIso: input.deadline > 0 ? new Date(input.deadline * 1000).toISOString() : "",
    verdictLabel: verdictLabel(input),
    payoutLabel:
      input.state === "resolved" && typeof input.payout === "number" && input.payout > 0
        ? `${formatPot(input.payout)} ${copy.paidOut}`
        : "",
    seriesLabel: seriesLabel(input),
    locked: false,
  };
}

/** Compact pot formatting — the card has no room for six decimals. */
export function formatPot(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(2);
}

/**
 * The public share URL. Only the claim id ever appears — never an invite key,
 * which would end up in CDN cache keys, referrer headers and access logs.
 */
export function shareCardPath(claimId: number, size: CardSize = "og"): string {
  return size === "og" ? `/api/share/${claimId}` : `/api/share/${claimId}?size=${size}`;
}

/** Detects an invite key smuggled into a share URL, for the guard test. */
export function shareUrlLeaksInviteKey(url: string): boolean {
  return /(invite|inviteKey|invite_key|pass|key)=/i.test(url);
}
