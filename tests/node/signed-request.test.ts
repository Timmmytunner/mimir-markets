import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_SIGNED_REQUEST_BODY_BYTES,
  bodyHash,
  checkSignedRequestBodySize,
  utf8ByteLength,
  verifySignedRequest,
  type SignedRequestEnvelope,
} from "../../lib/api/signed-request";

const NETWORK = "Test SDF Network ; September 2015";
const WALLET = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const NOW = 1_780_000_000_000;

function envelope(rawBody: string, overrides: Partial<SignedRequestEnvelope> = {}): SignedRequestEnvelope {
  return {
    version: 1,
    agentId: "sandbox-agent",
    operatorWallet: WALLET,
    method: "POST",
    path: "/api/agents/v1/stake",
    nonce: "nonce-1",
    timestamp: NOW,
    network: NETWORK,
    bodyHash: bodyHash(rawBody),
    ...overrides,
  };
}

test("utf8ByteLength counts multi-byte characters", () => {
  assert.equal(utf8ByteLength("a"), 1);
  assert.equal(utf8ByteLength("é"), 2);
});

test("checkSignedRequestBodySize accepts empty and boundary bodies", () => {
  assert.equal(checkSignedRequestBodySize("").ok, true);
  assert.equal(checkSignedRequestBodySize("x".repeat(MAX_SIGNED_REQUEST_BODY_BYTES)).ok, true);
});

test("checkSignedRequestBodySize rejects oversized bodies", () => {
  const raw = "x".repeat(MAX_SIGNED_REQUEST_BODY_BYTES + 1);
  const result = checkSignedRequestBodySize(raw);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "payload_too_large");
  assert.ok(utf8ByteLength(raw) > MAX_SIGNED_REQUEST_BODY_BYTES);
});

test("verifySignedRequest fails closed on oversized rawBody before other checks", () => {
  const raw = "x".repeat(MAX_SIGNED_REQUEST_BODY_BYTES + 1);
  const result = verifySignedRequest({
    envelope: envelope(""), // deliberately mismatched hash — size must win
    rawBody: raw,
    actualMethod: "POST",
    actualPath: "/api/agents/v1/stake",
    expectedNetwork: NETWORK,
    signedWallet: WALLET,
    registeredOperatorWallet: WALLET,
    usedNonces: new Set(),
    now: NOW,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "payload_too_large");
});

test("verifySignedRequest accepts a body at the size boundary", () => {
  const raw = "x".repeat(MAX_SIGNED_REQUEST_BODY_BYTES);
  const result = verifySignedRequest({
    envelope: envelope(raw),
    rawBody: raw,
    actualMethod: "POST",
    actualPath: "/api/agents/v1/stake",
    expectedNetwork: NETWORK,
    signedWallet: WALLET,
    registeredOperatorWallet: WALLET,
    usedNonces: new Set(),
    now: NOW,
  });
  assert.equal(result.ok, true);
});
