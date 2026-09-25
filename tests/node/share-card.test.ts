import assert from "node:assert/strict";
import test from "node:test";

import { SHARE_REF_VALUE, ZERO_ADDRESS, getShareUrl, shortenAddress } from "../../lib/constants";
import {
  CARD_SIZES,
  MAX_CLAIM_CHARS,
  buildShareCard,
  formatPot,
  isAbsentIdentity,
  isCardSize,
  isWalletAddress,
  resolveIdentity,
  shareCardDomain,
  shareCardPath,
  shareUrlLeaksInviteKey,
  type ShareCardInput,
} from "../../lib/share-card";
import { toCanonicalMode } from "../../lib/market-modes";

const POOL = toCanonicalMode({ marketType: "binary", oddsMode: "pool", maxChallengers: 10 });
const DUEL = toCanonicalMode({ marketType: "binary", oddsMode: "pool", maxChallengers: 1 });

function input(overrides: Partial<ShareCardInput> = {}): ShareCardInput {
  return {
    claimId: 12,
    question: "Will BTC close above $100,000 on 2026-05-25 according to CoinGecko?",
    creatorPosition: "Yes, it closes above",
    counterPosition: "No, it closes below",
    resolutionUrl: "https://www.coingecko.com/en/coins/bitcoin",
    totalPot: 40,
    mode: POOL,
    deadline: 1_780_000_000,
    state: "active",
    isPrivate: false,
    ...overrides,
  };
}

// ── Privacy: the reason this module is separate from the renderer ──────────────

test("a private market's card reveals nothing about the claim", () => {
  // An OG scraper fetches this URL by definition, holding no invite key.
  const card = buildShareCard(input({ isPrivate: true }));
  assert.equal(card.locked, true);
  assert.equal(card.title, "Private claim on Mimir");
  const serialized = JSON.stringify(card);
  assert.equal(serialized.includes("BTC"), false, "the question leaked");
  assert.equal(serialized.includes("100,000"), false, "the threshold leaked");
  assert.equal(serialized.includes("coingecko"), false, "the source leaked");
  assert.equal(card.sourceDomain, "");
  assert.equal(card.potLabel, "", "the pot size leaked");
  assert.equal(card.deadlineIso, "", "the deadline leaked");
});

test("a private settled market does not leak the verdict either", () => {
  const card = buildShareCard(
    input({ isPrivate: true, state: "resolved", winnerSide: "creator", payout: 40 }),
  );
  assert.equal(card.verdictLabel, "");
  assert.equal(card.payoutLabel, "");
});

test("the share URL carries only the claim id", () => {
  const path = shareCardPath(12);
  assert.equal(path, "/api/share/12");
  assert.equal(shareUrlLeaksInviteKey(path), false);
  assert.equal(shareUrlLeaksInviteKey(shareCardPath(12, "x")), false);
  // The guard itself must actually catch a smuggled key.
  assert.equal(shareUrlLeaksInviteKey("/api/share/12?invite=hunter2"), true);
  assert.equal(shareUrlLeaksInviteKey("/api/share/12?invite_key=abc"), true);
  assert.equal(shareUrlLeaksInviteKey("/api/share/12?pass=abc"), true);
});

// ── Content ───────────────────────────────────────────────────────────────────

test("a public market card carries the claim, sides, pot and source domain", () => {
  const card = buildShareCard(input());
  assert.match(card.title, /Will BTC close above/);
  assert.equal(card.sideA, "Yes, it closes above");
  assert.equal(card.sideB, "No, it closes below");
  assert.equal(card.sourceDomain, "coingecko.com");
  assert.equal(card.potLabel, "40 USDC");
  assert.equal(card.modeLabel, "Pool Market");
  assert.equal(card.locked, false);
});

test("a long claim is truncated on a word boundary and the cut is visible", () => {
  const long = "Will the ".repeat(60) + "market resolve?";
  const card = buildShareCard(input({ question: long }));
  assert.ok(card.title.length <= MAX_CLAIM_CHARS + 1, "must fit the card");
  assert.ok(card.title.endsWith("…"), "truncation must be visible, not silent");
  assert.equal(card.title.includes("  "), false, "whitespace must be collapsed");
});

test("a claim at the limit is not truncated", () => {
  const exact = "x".repeat(MAX_CLAIM_CHARS);
  assert.equal(buildShareCard(input({ question: exact })).title, exact);
});

test("emoji truncation never emits a broken surrogate pair", () => {
  const card = buildShareCard(input({ question: `${"🚀".repeat(150)} finish` }));
  assert.equal(card.title.includes("�"), false);
  assert.ok(card.title.endsWith("…"));
});

test("card copy can be localized without changing financial data", () => {
  const card = buildShareCard(
    input({ locale: "tr", state: "resolved", winnerSide: "draw", totalPot: 40 }),
  );
  assert.match(card.verdictLabel, /Berabere/);
  assert.equal(card.potLabel, "40 USDC");
});

test("missing avatars use deterministic identity fallbacks", () => {
  const fallback = buildShareCard(input({ creatorIdentity: "", challengerIdentity: "" }));
  assert.equal(fallback.avatarFallbackA, "C");
  assert.equal(fallback.avatarFallbackB, "CS");

  const identities = buildShareCard(
    input({ creatorIdentity: "Ada Lovelace", challengerIdentity: "0xabc123" }),
  );
  assert.equal(identities.avatarFallbackA, "AL");
  assert.equal(identities.avatarFallbackB, "0x");
});

// ── Wallet addresses (privacy: handled explicitly, never printed whole) ───────

const STELLAR_CREATOR = `G${"A".repeat(55)}`;
const STELLAR_CHALLENGER = `G${"B".repeat(55)}`;

function serialized(card: ReturnType<typeof buildShareCard>): string {
  return JSON.stringify(card);
}

test("a public card shortens a wallet address instead of publishing it whole", () => {
  const card = buildShareCard(
    input({ creatorIdentity: STELLAR_CREATOR, challengerIdentity: STELLAR_CHALLENGER }),
  );
  assert.equal(card.actorA, shortenAddress(STELLAR_CREATOR));
  assert.equal(card.actorB, shortenAddress(STELLAR_CHALLENGER));
  assert.equal(serialized(card).includes(STELLAR_CREATOR), false, "the creator address leaked");
  assert.equal(serialized(card).includes(STELLAR_CHALLENGER), false, "the challenger address leaked");
});

test("address shortening keeps both ends so the label stays recognisable", () => {
  const card = buildShareCard(input({ creatorIdentity: STELLAR_CREATOR }));
  assert.ok(card.actorA.includes("..."), "a shortened address is still a recognisable label");
  assert.ok(card.actorA.length < STELLAR_CREATOR.length);
});

test("an absent challenger never prints the zero-address sentinel", () => {
  // decodeClaim writes ZERO_ADDRESS when a claim has no challenger yet, so this
  // is the common case, not an edge case.
  const card = buildShareCard(input({ challengerIdentity: ZERO_ADDRESS }));
  assert.equal(card.actorB, "Challenger side");
  assert.equal(card.avatarFallbackB, "CS");
  assert.equal(serialized(card).includes("0x0000"), false, "the sentinel leaked onto the card");
});

test("a duel with no rival says Open rival, not an address", () => {
  const card = buildShareCard(input({ mode: DUEL, challengerIdentity: ZERO_ADDRESS }));
  assert.equal(card.actorB, "Open rival");
});

test("a display name is never shortened", () => {
  const card = buildShareCard(input({ creatorIdentity: "Ada Lovelace" }));
  assert.equal(card.actorA, "Ada Lovelace");
  assert.equal(card.avatarFallbackA, "AL");
});

// ── Address detection boundaries ──────────────────────────────────────────────

test("account, contract and EVM addresses are recognised as wallets", () => {
  assert.equal(isWalletAddress(STELLAR_CREATOR), true);
  assert.equal(isWalletAddress(`C${"A".repeat(55)}`), true, "contract strkeys count too");
  assert.equal(isWalletAddress(`0x${"a".repeat(40)}`), true);
});

test("display names and short hex are not misread as addresses", () => {
  assert.equal(isWalletAddress("Ada Lovelace"), false);
  assert.equal(isWalletAddress("creator.mimir"), false);
  // A short hex pseudonym is a name, not a 20-byte address — shortening it would
  // make it longer than it started.
  assert.equal(isWalletAddress("0xabc123"), false);
});

test("absence covers empty, whitespace, the sentinel and all-zero addresses", () => {
  assert.equal(isAbsentIdentity(""), true);
  assert.equal(isAbsentIdentity("   "), true);
  assert.equal(isAbsentIdentity(undefined), true);
  assert.equal(isAbsentIdentity(ZERO_ADDRESS), true);
  assert.equal(isAbsentIdentity(`0x${"0".repeat(40)}`), true);
  assert.equal(isAbsentIdentity("0xabc123"), false);
  assert.equal(isAbsentIdentity(STELLAR_CREATOR), false);
});

test("resolveIdentity falls back rather than returning the sentinel", () => {
  assert.equal(resolveIdentity(ZERO_ADDRESS, "Creator"), "Creator");
  assert.equal(resolveIdentity(undefined, "Creator"), "Creator");
  assert.equal(resolveIdentity("  ", "Creator"), "Creator");
  assert.equal(resolveIdentity(STELLAR_CREATOR, "Creator"), shortenAddress(STELLAR_CREATOR));
});

test("duel cards use duel language and rival wording", () => {
  const card = buildShareCard(input({ mode: DUEL }));
  assert.equal(card.kind, "duel");
  assert.equal(card.modeLabel, "Duel");
  assert.equal(card.economicsLabel, "Winner takes the pot");

  const settled = buildShareCard(
    input({ mode: DUEL, state: "resolved", winnerSide: "challengers", payout: 20 }),
  );
  assert.equal(settled.verdictLabel, "Rival wins", "a duel has a rival, not challengers");
});

test("a pool settlement says challengers, not rival", () => {
  const card = buildShareCard(input({ state: "resolved", winnerSide: "challengers", payout: 44 }));
  assert.equal(card.kind, "settlement");
  assert.equal(card.verdictLabel, "Challengers win");
  assert.equal(card.payoutLabel, "44 USDC paid out");
});

test("draws and unresolvable outcomes say refunded, not won", () => {
  assert.match(
    buildShareCard(input({ state: "resolved", winnerSide: "draw" })).verdictLabel,
    /refunded in full/,
  );
  assert.match(
    buildShareCard(input({ state: "resolved", winnerSide: "unresolvable" })).verdictLabel,
    /refunded in full/,
  );
  assert.match(buildShareCard(input({ state: "cancelled" })).verdictLabel, /refunded/);
});

test("a resolved card with no payout does not claim one", () => {
  const card = buildShareCard(input({ state: "resolved", winnerSide: "draw", payout: 0 }));
  assert.equal(card.payoutLabel, "");
});

test("rematch cards show the round and series score", () => {
  const card = buildShareCard(
    input({ series: { round: 3, bestOf: 5, creatorWins: 2, challengerWins: 1 } }),
  );
  assert.equal(card.kind, "rematch");
  assert.equal(card.seriesLabel, "Round 3 · Best of 5 · 2–1");
});

test("a rematch outside a best-of series omits the bestOf", () => {
  const card = buildShareCard(input({ series: { round: 2, creatorWins: 1, challengerWins: 0 } }));
  assert.equal(card.seriesLabel, "Round 2 · 1–0");
});

test("an unparseable source URL yields an empty domain, not a crash", () => {
  assert.equal(shareCardDomain("not a url"), "");
  assert.equal(buildShareCard(input({ resolutionUrl: "nonsense" })).sourceDomain, "");
});

test("a market with no deadline omits it rather than rendering epoch zero", () => {
  assert.equal(buildShareCard(input({ deadline: 0 })).deadlineIso, "");
});

// ── Sizes ─────────────────────────────────────────────────────────────────────

test("every named platform size renders", () => {
  for (const size of ["og", "x", "farcaster"] as const) {
    const card = buildShareCard(input(), size);
    assert.deepEqual(card.size, CARD_SIZES[size]);
    assert.ok(card.size.width > 0 && card.size.height > 0);
  }
});

test("size names are validated", () => {
  assert.equal(isCardSize("og"), true);
  assert.equal(isCardSize("x"), true);
  assert.equal(isCardSize("instagram"), false);
});

// ── Pot formatting ────────────────────────────────────────────────────────────

test("pot formatting is compact and never shows six decimals", () => {
  assert.equal(formatPot(40), "40");
  assert.equal(formatPot(40.5), "40.50");
  assert.equal(formatPot(1_500), "1.5k");
  assert.equal(formatPot(2_400_000), "2.4M");
  assert.equal(formatPot(0), "0");
  assert.equal(formatPot(-5), "0");
  assert.equal(formatPot(Number.NaN), "0");
});

// ── Determinism ───────────────────────────────────────────────────────────────

test("the same claim state always produces the same card", () => {
  // Required for CDN caching and so two viewers see the same thing.
  assert.deepEqual(buildShareCard(input()), buildShareCard(input()));
});

// ── Share attribution (§02) ───────────────────────────────────────────────────

test("a shared link carries the attribution marker", () => {
  // share_card_generated fires when a card is scraped; this is what lets
  // share_card_clicked fire when the traffic actually arrives.
  const url = getShareUrl(42);
  assert.match(url, /[?&]ref=share(&|$)/);
});

test("the marker is a fixed literal, not a per-share token", () => {
  // A unique id per share would tie a visit back to whoever shared it. The
  // question is "did shares bring traffic", not "who did".
  assert.equal(getShareUrl(1), getShareUrl(1));
  assert.equal(SHARE_REF_VALUE, "share");
});

test("an invite key survives alongside the marker", () => {
  const url = getShareUrl(42, "secret key");
  assert.match(url, /invite=secret\+key/);
  assert.match(url, /ref=share/);
});

test("the invite key is still not in the CARD url", () => {
  // The card is public and scraped without a session; the marker must not have
  // dragged an invite key into it.
  assert.equal(shareUrlLeaksInviteKey(shareCardPath(42)), false);
});
