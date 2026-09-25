/**
 * PATCH /api/baskets/[id] — transfer ownership of a user-composed basket.
 *
 * ── Why this exists ───────────────────────────────────────────────────────────
 *
 * A basket's creator_wallet is both the identity key and the fee recipient.
 * Wallets rotate; operators hand off products; teams change. Without a transfer
 * path the only escape is "delete and re-create", which destroys the basket's
 * subscription list and historical NAV — a bad deal for every subscriber.
 *
 * ── Security model ────────────────────────────────────────────────────────────
 *
 * The authorisation proof is an Ed25519 signature by the CURRENT owner over
 * transferMessage({ basketId, currentOwner, newOwner }).  No session, no JWT —
 * same pattern as basket creation and subscription.
 *
 * Guards applied in order (first failure wins):
 *  1. Rate-limit gate (public_read — IP + route, matches other basket routes).
 *  2. Both wallet addresses are valid Stellar G… strkeys, trimmed verbatim.
 *  3. currentOwner ≠ newOwner (a no-op transfer is rejected).
 *  4. nonce present (client-generated UUID, consumed after first use).
 *  5. expiresAt is finite, in the future, and within TRANSFER_EXPIRY_MS of now.
 *  6. Curated basket interception — those have no DB row, clear 403.
 *  7. Basket exists in user_baskets.
 *  8. currentOwner matches stored creator_wallet (verbatim).
 *  9. Signature by currentOwner over transferMessage verifies.
 * 10. Atomic DB update + nonce consumption (transferBasket throws on nonce
 *     replay via UNIQUE constraint; returns false on owner-mismatch race).
 *
 * ── Funded-flow safety ────────────────────────────────────────────────────────
 *
 * Subscriptions are NOT touched: a subscriber consented to follow THIS basket
 * (by id), not a specific owner. Changing the owner does not change what the
 * basket contains or how it performs. The new owner inherits the subscriber list
 * and the NAV history exactly as-is.
 *
 * The basket creator fee (FEE_SCHEDULE.basketCreatorBps) accrues to creator_wallet
 * at settlement time, so future settlements after a transfer correctly route to
 * the new owner. Settlements already finalised before the transfer are unaffected —
 * they were stamped with the prior owner's address at snapshot time.
 *
 * BASKET_DEPOSITS_ENABLED is false today (ADR-0008). When it is enabled the same
 * transfer route serves funded baskets: creator_wallet in basket_definitions will
 * need a parallel update (separate migration, separate route action). That is
 * intentionally deferred — the funded-vault path does not exist yet.
 *
 * ── PR notes ─────────────────────────────────────────────────────────────────
 *
 * Accounting impact : future basketCreatorBps fees route to newOwner.
 *                     Past settlements are unaffected.
 * Wallet impact     : currentOwner loses fee rights; newOwner gains them.
 *                     No funds move. No keys are escrowed.
 * Accessibility     : JSON-only endpoint; no UI surface in this PR.
 * Migration impact  : basket_ownership_transfers table created by ensureSchema()
 *                     on first request to any basket route (IF NOT EXISTS).
 *                     Zero downtime; no backfill required.
 */

import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";

import { isStellarAccount, verifyStellarSignedMessage } from "@/lib/stellar-message";
import { apiError } from "@/lib/api/errors";
import { authorizeRequest } from "@/lib/api/policy";
import { transferMessage, TRANSFER_EXPIRY_MS } from "@/lib/baskets";
import { getBasket, transferBasket } from "@/lib/db";
import { findBasketDefinition } from "@/lib/server/basket-directory";

export const dynamic = "force-dynamic";

function clientIp(req: NextRequest): string | undefined {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || undefined;
}

export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;

  const gate = authorizeRequest("public_read", { route: "/api/baskets/transfer", ip: clientIp(req) });
  if (!gate.allowed && gate.error) {
    return NextResponse.json(gate.error.body, { status: gate.error.status, headers: gate.error.headers });
  }

  let body: { currentOwner?: string; newOwner?: string; nonce?: string; expiresAt?: number; signature?: string };
  try {
    body = await req.json();
  } catch {
    const err = apiError("invalid_request", "invalid JSON");
    return NextResponse.json(err.body, { status: err.status });
  }

  // Both addresses trimmed, never lowercased — strkeys are case-sensitive base32.
  const currentOwner = String(body.currentOwner ?? "").trim();
  const newOwner = String(body.newOwner ?? "").trim();

  if (!isStellarAccount(currentOwner)) {
    const err = apiError("invalid_request", "currentOwner must be a valid Stellar account address", { field: "currentOwner" });
    return NextResponse.json(err.body, { status: err.status });
  }
  if (!isStellarAccount(newOwner)) {
    const err = apiError("invalid_request", "newOwner must be a valid Stellar account address", { field: "newOwner" });
    return NextResponse.json(err.body, { status: err.status });
  }
  if (currentOwner === newOwner) {
    const err = apiError("invalid_request", "newOwner must differ from currentOwner");
    return NextResponse.json(err.body, { status: err.status });
  }

  // Nonce: client-generated, consumed after first use to prevent replay.
  const nonce = String(body.nonce ?? "").trim();
  if (!nonce) {
    const err = apiError("invalid_request", "nonce is required", { field: "nonce" });
    return NextResponse.json(err.body, { status: err.status });
  }

  // expiresAt: must be a finite number in the future, and within the allowed
  // signing window so a very long-lived token cannot be stockpiled.
  const expiresAt = Number(body.expiresAt ?? 0);
  const now = Date.now();
  if (!Number.isFinite(expiresAt) || expiresAt <= now) {
    const err = apiError("request_expired", "expiresAt is missing or already past");
    return NextResponse.json(err.body, { status: err.status });
  }
  if (expiresAt > now + TRANSFER_EXPIRY_MS) {
    const err = apiError("invalid_request", `expiresAt may not be more than ${TRANSFER_EXPIRY_MS / 1000}s in the future`, { field: "expiresAt" });
    return NextResponse.json(err.body, { status: err.status });
  }

  // Curated baskets have no user_baskets row. Attempting to transfer one would
  // produce a confusing "owner mismatch" response, so we intercept it here with
  // a clear "not found" — the curated list is immutable by design.
  if (findBasketDefinition(id) !== null) {
    const err = apiError("forbidden", "curated baskets cannot be transferred");
    return NextResponse.json(err.body, { status: err.status });
  }

  const basket = await getBasket(id).catch(() => null);
  if (!basket) {
    const err = apiError("not_found", "no such basket");
    return NextResponse.json(err.body, { status: err.status });
  }

  // Verbatim comparison — strkeys are case-sensitive base32.
  if (basket.creatorWallet !== currentOwner) {
    const err = apiError("forbidden", "currentOwner does not match the basket's owner");
    return NextResponse.json(err.body, { status: err.status });
  }

  const signature = String(body.signature ?? "").trim();
  if (!signature) {
    const err = apiError("invalid_signature", "owner signature is required");
    return NextResponse.json(err.body, { status: err.status });
  }

  // Ed25519 does not recover the signer — the public key is an explicit input.
  // The address verified here is the one we just confirmed matches the DB row,
  // so there is no "signed as someone else" branch.
  const valid = verifyStellarSignedMessage({
    address: currentOwner,
    message: transferMessage({ basketId: id, currentOwner, newOwner, nonce, expiresAt }),
    signature,
  });
  if (!valid) {
    const err = apiError("invalid_signature", "owner signature rejected");
    return NextResponse.json(err.body, { status: err.status });
  }

  // transferBasket stores the nonce inside the same transaction as the owner
  // update. The UNIQUE(nonce) constraint makes replay rejection atomic: if the
  // same signed payload is submitted twice (or an old sig is replayed after
  // ownership cycles back), the INSERT throws and the whole transaction rolls
  // back. We catch that as a 409 so the client gets a clear error rather than
  // a 500.
  let transferred: boolean;
  try {
    transferred = await transferBasket({
      transferId: randomUUID(),
      basketId: id,
      fromWallet: currentOwner,
      toWallet: newOwner,
      nonce,
      at: now,
    });
  } catch {
    // The only expected throw from transferBasket is the UNIQUE(nonce) violation.
    const err = apiError("conflict", "transfer nonce already used; this authorisation has been consumed");
    return NextResponse.json(err.body, { status: err.status });
  }

  // false means the DB row changed between our getBasket() read and the UPDATE —
  // another concurrent transfer landed first. Treat it as a conflict so the
  // caller can re-read and decide whether to retry.
  if (!transferred) {
    const err = apiError("conflict", "basket ownership changed concurrently; re-read the basket and retry");
    return NextResponse.json(err.body, { status: err.status });
  }

  return NextResponse.json(
    { basketId: id, owner: newOwner },
    { headers: { "cache-control": "no-store" } },
  );
}
