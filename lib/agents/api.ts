import { sha256Hex } from "@/lib/content-hash";

export const AGENT_API_VERSION = "v1";
export const AGENT_API_ACTIONS = [
  "register", "heartbeat", "proposeMarket", "createMarket", "publishReasoning",
  "vote", "stake", "listPositions", "listEarnings", "revoke", "dryRun",
  // Credential and budget management. issueKey/revokeKey/rotateKey and grantSpend
  // are owner-signed; the rest an agent may call with its own key.
  // rotateKey issues a fresh key and schedules the old one's expiry so both are
  // valid during the overlap window — callers have time to update their credential.
  "issueKey", "listKeys", "revokeKey", "rotateKey", "grantSpend", "revokeSpend", "spendStatus",
] as const;
export type AgentApiAction = (typeof AGENT_API_ACTIONS)[number];

export interface SignedAgentRequest<T = unknown> {
  version: typeof AGENT_API_VERSION;
  agentId: string;
  action: AgentApiAction;
  idempotencyKey: string;
  nonce: string;
  signedAt: number;
  body: T;
  /** Base64 Ed25519 signature over {@link agentRequestMessage}, as SEP-43 returns it. */
  signature: string;
}

export const AGENT_REQUEST_MAX_SKEW_MS = 5 * 60_000;

/**
 * Cap on the UTF-8 byte size of the signed request `body` field (JSON).
 *
 * The agent API is a money-moving surface; unbounded bodies let a caller force
 * expensive stable-stringify + hashing work before the envelope is rejected.
 * Reuses the same 64 KiB bound as {@link MAX_SIGNED_REQUEST_BODY_BYTES} in
 * `lib/api/signed-request.ts`.
 */
export const MAX_SIGNED_REQUEST_PAYLOAD_BYTES = 64 * 1024;

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** UTF-8 byte length of a JSON-serialisable value (the body size we enforce). */
export function signedRequestPayloadBytes(body: unknown): number {
  const raw = body === undefined ? "null" : JSON.stringify(body);
  return new TextEncoder().encode(raw ?? "null").length;
}

export function agentRequestMessage(request: Omit<SignedAgentRequest, "signature">): string {
  const bodyHash = sha256Hex(stable(request.body));
  return [
    "Mimir Agent API request", `version: ${request.version}`, `agent: ${request.agentId}`,
    `action: ${request.action}`, `idempotency: ${request.idempotencyKey}`,
    `nonce: ${request.nonce}`, `signedAt: ${request.signedAt}`, `bodyHash: ${bodyHash}`,
  ].join("\n");
}

/**
 * Validate the envelope.
 *
 * `requireSignature: false` is for API-key callers: the server fills the nonce and
 * timestamp itself for them, so demanding a signed, clock-synced envelope would be
 * demanding proof of something the key already established. The signed path keeps
 * every check, because there the envelope IS the credential.
 */
export function validateAgentRequestEnvelope(
  request: SignedAgentRequest,
  now = Date.now(),
  opts: { requireSignature?: boolean } = {},
): string[] {
  const requireSignature = opts.requireSignature ?? true;
  const errors: string[] = [];
  if (!requireSignature) {
    if (request.version !== AGENT_API_VERSION) errors.push("unsupported version");
    if (!(AGENT_API_ACTIONS as readonly string[]).includes(request.action)) errors.push("unknown action");
    if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(request.agentId)) errors.push("invalid agentId");
    if (request.idempotencyKey && request.idempotencyKey.length > 128) errors.push("invalid idempotencyKey");
    if (signedRequestPayloadBytes(request.body) > MAX_SIGNED_REQUEST_PAYLOAD_BYTES) {
      errors.push(`payload exceeds ${MAX_SIGNED_REQUEST_PAYLOAD_BYTES} bytes`);
    }
    return errors;
  }
  if (request.version !== AGENT_API_VERSION) errors.push("unsupported version");
  if (!(AGENT_API_ACTIONS as readonly string[]).includes(request.action)) errors.push("unknown action");
  if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(request.agentId)) errors.push("invalid agentId");
  if (!request.idempotencyKey || request.idempotencyKey.length > 128) errors.push("invalid idempotencyKey");
  if (!request.nonce || request.nonce.length > 128) errors.push("invalid nonce");
  if (!Number.isFinite(request.signedAt) || Math.abs(now - request.signedAt) > AGENT_REQUEST_MAX_SKEW_MS) {
    errors.push("signed timestamp outside allowed window");
  }
  // Base64, as SEP-43 `signMessage` returns it. An Ed25519 signature is always
  // 64 bytes, which is 86 base64 characters plus padding — but the length is
  // checked where the bytes are decoded (`verifyStellarSignedMessage`), because
  // that is where a wrong length can be reported as a failed verification rather
  // than as a malformed envelope. This is only a cheap "did the client send
  // anything credential-shaped" gate.
  if (!/^[A-Za-z0-9+/]{16,}={0,2}$/.test(request.signature)) {
    errors.push("invalid signature encoding");
  }
  if (signedRequestPayloadBytes(request.body) > MAX_SIGNED_REQUEST_PAYLOAD_BYTES) {
    errors.push(`payload exceeds ${MAX_SIGNED_REQUEST_PAYLOAD_BYTES} bytes`);
  }
  return errors;
}
