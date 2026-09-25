import assert from "node:assert/strict";
import test from "node:test";
import {
  agentRequestMessage,
  validateAgentRequestEnvelope,
  signedRequestPayloadBytes,
  MAX_SIGNED_REQUEST_PAYLOAD_BYTES,
  type SignedAgentRequest,
} from "../../lib/agents/api";

const NOW = 1_780_000_000_000;
function request(overrides: Partial<SignedAgentRequest> = {}): SignedAgentRequest {
  return { version: "v1", agentId: "sandbox-agent", action: "heartbeat",
    idempotencyKey: "heartbeat-1", nonce: "nonce-1", signedAt: NOW,
    // Base64, as SEP-43 `signMessage` returns it. The old `"0x12"` was hex, which
    // the envelope gate now rejects — Ed25519 signatures are not hex here.
    body: { b: 2, a: 1 }, signature: "c2lnbmF0dXJlLWJ5dGVzLWJhc2U2NA==", ...overrides };
}

test("signed request body hashing is canonical across object key order", () => {
  const a = request({ body: { a: 1, b: 2 } });
  const b = request({ body: { b: 2, a: 1 } });
  assert.equal(agentRequestMessage(a), agentRequestMessage(b));
  // SHA-256, bare hex — no `0x` prefix. Soroban's own hash, so a contract could
  // recompute it; keccak256 has no host-function counterpart.
  assert.match(agentRequestMessage(a), /bodyHash: [0-9a-f]{64}$/);
});

test("request envelope is versioned, timestamped and nonce/idempotency bound", () => {
  assert.deepEqual(validateAgentRequestEnvelope(request(), NOW), []);
  // A hex signature is no longer credential-shaped: the EVM arm is gone.
  assert.match(
    validateAgentRequestEnvelope(request({ signature: "0xdeadbeef" }), NOW).join(" "),
    /signature encoding/,
  );
  assert.match(validateAgentRequestEnvelope(request({ signedAt: NOW - 6 * 60_000 }), NOW).join(" "), /timestamp/);
  assert.match(validateAgentRequestEnvelope(request({ nonce: "" }), NOW).join(" "), /nonce/);
  assert.match(validateAgentRequestEnvelope(request({ idempotencyKey: "" }), NOW).join(" "), /idempotency/);
});

test("the signature message binds action and idempotency key", () => {
  assert.notEqual(agentRequestMessage(request()), agentRequestMessage(request({ action: "stake" })));
  assert.notEqual(agentRequestMessage(request()), agentRequestMessage(request({ idempotencyKey: "heartbeat-2" })));
});


test("signed request body within the payload cap is accepted", () => {
  const body = { note: "x".repeat(1024) };
  assert.ok(signedRequestPayloadBytes(body) <= MAX_SIGNED_REQUEST_PAYLOAD_BYTES);
  assert.deepEqual(validateAgentRequestEnvelope(request({ body }), NOW), []);
});

test("signed request body over the payload cap is rejected", () => {
  const body = { note: "x".repeat(MAX_SIGNED_REQUEST_PAYLOAD_BYTES) };
  assert.ok(signedRequestPayloadBytes(body) > MAX_SIGNED_REQUEST_PAYLOAD_BYTES);
  assert.match(
    validateAgentRequestEnvelope(request({ body }), NOW).join(" "),
    /payload exceeds/,
  );
});

test("payload cap applies on the API-key path too", () => {
  const body = { note: "y".repeat(MAX_SIGNED_REQUEST_PAYLOAD_BYTES) };
  assert.match(
    validateAgentRequestEnvelope(request({ body }), NOW, { requireSignature: false }).join(" "),
    /payload exceeds/,
  );
});
