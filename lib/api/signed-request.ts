/**
 * Signed agent requests.
 *
 * Any endpoint that moves money or changes authority must prove three things
 * before it acts:
 *
 *   who    a wallet signature over the request
 *   once   a nonce, so a captured request cannot be replayed
 *   fresh  a timestamp, so an old capture cannot be replayed later either
 *
 * A nonce alone is not enough: without expiry the server must remember every
 * nonce forever. A timestamp alone is not enough either: inside the freshness
 * window a captured request could be replayed repeatedly. Both together bound the
 * replay set to one window, so the nonce store can be a small TTL cache.
 *
 * The signature covers a canonical digest of METHOD, PATH, BODY, nonce, timestamp
 * and network. Signing only the body would let an attacker replay a valid
 * "stake 5 USDC" body against a different route.
 *
 * `network` is the Stellar network passphrase, replacing the EVM numeric chain
 * id: it is the string every Stellar signature is already bound to at the
 * protocol level, so naming it here keeps a Testnet-signed request from
 * authorising anything on Pubnet.
 */

import { sha256Hex } from "@/lib/content-hash";

export const SIGNED_REQUEST_VERSION = 1;

/** How long a signed request stays valid. */
export const REQUEST_TTL_MS = 60_000;
/** Tolerance for a client clock running ahead of ours. */
export const CLOCK_SKEW_MS = 10_000;
/**
 * Hard cap on the raw signed request body (UTF-8 bytes).
 *
 * Oversized bodies are refused before hashing or crypto so a caller cannot force
 * the server to hash/parse megabytes just to reject the signature later. 64 KiB
 * covers every legitimate agent action (stake, reasoning, registration metadata)
 * while still bounding DoS surface on the money-moving path.
 */
export const MAX_SIGNED_REQUEST_BODY_BYTES = 64 * 1024;

export interface SignedRequestEnvelope {
  version: number;
  /** Registry id of the calling agent. */
  agentId: string;
  /** Wallet that produced the signature — the agent's operator key. */
  operatorWallet: string;
  method: string;
  path: string;
  /** Single-use value. */
  nonce: string;
  /** Client-side epoch ms. */
  timestamp: number;
  /** Stellar network passphrase this request is bound to. */
  network: string;
  /** SHA-256 of the raw request body, bare hex; empty string when there is no body. */
  bodyHash: string;
  /** Caller-chosen key that makes a retry safe. */
  idempotencyKey?: string;
}

/**
 * Canonical digest the agent signs.
 *
 * Field-separated with a character that cannot appear in a method, path, hex hash
 * or nonce, so no field value can forge a boundary and make two different
 * requests produce the same digest.
 */
const FIELD_SEPARATOR = String.fromCharCode(0x1f);

export function canonicalRequestDigest(envelope: SignedRequestEnvelope): string {
  const canonical = [
    "mimir-signed-request",
    String(envelope.version),
    envelope.agentId,
    // NOT lowercased: a Stellar strkey is case-sensitive base32.
    envelope.operatorWallet.trim(),
    envelope.method.toUpperCase(),
    envelope.path,
    envelope.nonce,
    String(envelope.timestamp),
    envelope.network,
    envelope.bodyHash,
    envelope.idempotencyKey ?? "",
  ].join(FIELD_SEPARATOR);
  return sha256Hex(canonical);
}

export function bodyHash(raw: string): string {
  return raw.length === 0 ? "" : sha256Hex(raw);
}

/** UTF-8 byte length of a string — what Content-Length and the body cap measure. */
export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/**
 * Refuse a raw body that exceeds {@link MAX_SIGNED_REQUEST_BODY_BYTES}.
 *
 * Checked before hashing so the DoS bound does not depend on the caller also
 * running `verifySignedRequest`. Empty bodies are fine (length 0).
 */
export function checkSignedRequestBodySize(rawBody: string): VerifyResult {
  const bytes = utf8ByteLength(rawBody);
  if (bytes > MAX_SIGNED_REQUEST_BODY_BYTES) {
    return {
      ok: false,
      reason: "payload_too_large",
      detail: `body is ${bytes} bytes; max is ${MAX_SIGNED_REQUEST_BODY_BYTES}`,
    };
  }
  return { ok: true };
}

export type SignedRequestRejection =
  | "unsupported_version"
  | "invalid_request"
  | "payload_too_large"
  | "request_expired"
  | "nonce_reused"
  | "invalid_signature"
  | "forbidden";

export interface VerifyResult {
  ok: boolean;
  reason?: SignedRequestRejection;
  detail?: string;
}

export interface VerifySignedRequestArgs {
  envelope: SignedRequestEnvelope;
  /** Raw request body exactly as received — hashed, not parsed. */
  rawBody: string;
  /** Method and path the server actually served. */
  actualMethod: string;
  actualPath: string;
  /** Network passphrase this deployment serves. */
  expectedNetwork: string;
  /**
   * Wallet whose signature the caller verified. Ed25519 has no recovery, so this
   * is an input the caller checked against, not something derived from the bytes.
   */
  signedWallet: string;
  /** Operator wallet the registry has on file for this agent. */
  registeredOperatorWallet: string;
  /** Nonces already consumed inside the freshness window. */
  usedNonces: ReadonlySet<string>;
  now?: number;
}

/**
 * Verify everything except the cryptography, which the caller does through
 * `verifyAgentSignature` (Ed25519, or a contract account's `__check_auth`).
 *
 * Pure, so every rejection path is testable without signing keys.
 */
export function verifySignedRequest(args: VerifySignedRequestArgs): VerifyResult {
  const { envelope } = args;
  const now = args.now ?? Date.now();

  // Bound work before any hashing or field checks: an oversized body must not
  // reach sha256 or the nonce store.
  const sizeCheck = checkSignedRequestBodySize(args.rawBody);
  if (!sizeCheck.ok) return sizeCheck;

  if (envelope.version !== SIGNED_REQUEST_VERSION) {
    return {
      ok: false,
      reason: "unsupported_version",
      detail: `expected version ${SIGNED_REQUEST_VERSION}`,
    };
  }
  if (!envelope.agentId || !envelope.nonce || !envelope.operatorWallet) {
    return { ok: false, reason: "invalid_request", detail: "incomplete envelope" };
  }
  if (envelope.network !== args.expectedNetwork) {
    // A signature for another Stellar network must not authorise anything here.
    return { ok: false, reason: "forbidden", detail: "wrong network" };
  }

  // Method and path are signed, so a valid body cannot be replayed elsewhere.
  if (envelope.method.toUpperCase() !== args.actualMethod.toUpperCase()) {
    return { ok: false, reason: "invalid_request", detail: "method does not match the signature" };
  }
  if (envelope.path !== args.actualPath) {
    return { ok: false, reason: "invalid_request", detail: "path does not match the signature" };
  }

  // The body is hashed, never trusted as parsed JSON: two different byte strings
  // can parse to the same object, and it is the bytes that were signed.
  if (envelope.bodyHash !== bodyHash(args.rawBody)) {
    return { ok: false, reason: "invalid_request", detail: "body does not match the signature" };
  }

  if (now - envelope.timestamp > REQUEST_TTL_MS) {
    return { ok: false, reason: "request_expired", detail: "request is too old" };
  }
  if (envelope.timestamp - now > CLOCK_SKEW_MS) {
    return { ok: false, reason: "request_expired", detail: "request timestamp is in the future" };
  }
  if (args.usedNonces.has(envelope.nonce)) {
    return { ok: false, reason: "nonce_reused", detail: "nonce already used" };
  }

  // Exact string comparison throughout: strkeys are case-sensitive base32, so
  // case folding would both accept forgeries and reject legitimate wallets.
  if (args.signedWallet.trim() !== envelope.operatorWallet.trim()) {
    return { ok: false, reason: "invalid_signature", detail: "signature wallet mismatch" };
  }
  // The signature must come from the key the REGISTRY knows, not merely from the
  // key the request claims. Otherwise anyone could sign as any agent.
  if (args.registeredOperatorWallet.trim() !== envelope.operatorWallet.trim()) {
    return { ok: false, reason: "forbidden", detail: "not the registered operator wallet" };
  }

  return { ok: true };
}

// ── Idempotency ───────────────────────────────────────────────────────────────

export interface IdempotencyRecord {
  key: string;
  /** Hash of the body the key was first used with. */
  bodyHash: string;
  /** Response to replay, when the original completed. */
  response?: { status: number; body: unknown };
  createdAt: number;
}

export type IdempotencyOutcome =
  /** First time: proceed and record the result. */
  | { kind: "proceed" }
  /** Same key, same body, already completed: replay the stored response. */
  | { kind: "replay"; response: { status: number; body: unknown } }
  /** Same key, same body, still running: the caller must wait, not duplicate. */
  | { kind: "in_flight" }
  /** Same key, DIFFERENT body: refuse rather than guess which one was meant. */
  | { kind: "conflict" };

/**
 * Decide what to do with an idempotency key.
 *
 * A key reused with a different body is a caller bug, and guessing which request
 * was intended could double-spend. It is refused.
 */
export function checkIdempotency(
  key: string | undefined,
  currentBodyHash: string,
  store: ReadonlyMap<string, IdempotencyRecord>,
): IdempotencyOutcome {
  if (!key) return { kind: "proceed" };
  const existing = store.get(key);
  if (!existing) return { kind: "proceed" };
  if (existing.bodyHash !== currentBodyHash) return { kind: "conflict" };
  if (existing.response) return { kind: "replay", response: existing.response };
  return { kind: "in_flight" };
}
