/**
 * One place that answers "who is calling the agent API, and may they?".
 *
 * Two credentials are accepted and they are not interchangeable:
 *
 *   API key    — a bearer token. Convenient (plain HTTP, no signing), so it is what
 *                third-party agents use for everything they do repeatedly. What it
 *                can *spend* is bounded by the owner-signed spend permission, not by
 *                the key, which is what makes a leaked key survivable.
 *   Signature  — an owner-signed envelope. Required for the actions that change
 *                authority itself (register, revoke), because those must not be
 *                reachable by a credential the owner cannot see being used.
 *
 * Rate limiting happens here too, so no route can forget it.
 */

import { apiError, type ApiErrorResult } from "@/lib/api/errors";
import { authorizeRequest } from "@/lib/api/policy";
import { getAgentApiKeyByHash, touchAgentApiKey } from "@/lib/db";
import {
  checkApiKeyRecord, hashApiKey, parseApiKeyHeader,
} from "./api-keys";
import type { AgentApiAction } from "./api";

/**
 * Actions that establish or withdraw authority, so a bearer token is not enough.
 *
 * A key must not be able to mint another key or widen its own budget — that would
 * turn one leaked credential into permanent, self-renewing access.
 *
 * `rotateKey` is included for the same reason as `issueKey`: issuing a new key
 * and scheduling an expiry on the old one is a privileged authority action that
 * must be initiated by the owner, not by whatever credential is being replaced.
 */
export const OWNER_SIGNED_ACTIONS: readonly AgentApiAction[] = [
  "register", "revoke", "issueKey", "revokeKey", "rotateKey", "grantSpend", "revokeSpend",
];

export function requiresOwnerSignature(action: AgentApiAction): boolean {
  return OWNER_SIGNED_ACTIONS.includes(action);
}

export type AgentAuth =
  | { kind: "api_key"; agentId: string; keyId: string }
  | { kind: "signature" };

export interface AuthenticateResult {
  auth?: AgentAuth;
  error?: ApiErrorResult;
}

/**
 * Resolve the credential on a request.
 *
 * A present-but-bad key is an error rather than a silent fall-through to signature
 * checking: telling a developer "your key is revoked" is the difference between a
 * one-minute fix and an afternoon.
 */
export async function authenticateAgentRequest(args: {
  action: AgentApiAction;
  authorization: string | null;
  ip?: string;
  /** Agent id claimed by the request body, checked against the key's own agent. */
  claimedAgentId?: string;
}): Promise<AuthenticateResult> {
  const presented = parseApiKeyHeader(args.authorization);
  const route = `/api/agents/v1/${args.action}`;

  if (!presented) {
    // No key: the caller must be signing. Still rate-limited, by IP and route.
    const gate = authorizeRequest("public_read", { route, ip: args.ip });
    if (!gate.allowed && gate.error) return { error: gate.error };
    return { auth: { kind: "signature" } };
  }

  const record = await getAgentApiKeyByHash(hashApiKey(presented)).catch(() => null);
  const checked = checkApiKeyRecord(record, Date.now());
  if (!checked.ok) {
    return {
      error: apiError(
        "unauthenticated",
        checked.reason === "revoked"
          ? "API key revoked"
          : checked.reason === "expired"
            ? "API key expired"
            : "unknown API key",
      ),
    };
  }

  if (args.claimedAgentId && args.claimedAgentId !== checked.record.agentId) {
    // A key acting for another agent would let one developer spend another's
    // permission, which is the whole boundary this API exists to hold.
    return { error: apiError("forbidden", "key does not belong to this agent") };
  }

  if (requiresOwnerSignature(args.action)) {
    return {
      error: apiError(
        "forbidden",
        `${args.action} requires an owner signature, not an API key`,
      ),
    };
  }

  const gate = authorizeRequest("api_key_agent", {
    route, ip: args.ip, agentId: checked.record.agentId,
  });
  if (!gate.allowed && gate.error) return { error: gate.error };

  // Not awaited: a failed stamp is a reporting loss, not a reason to refuse a
  // request that was otherwise authorised.
  void touchAgentApiKey(checked.record.keyId, Date.now()).catch(() => undefined);

  return { auth: { kind: "api_key", agentId: checked.record.agentId, keyId: checked.record.keyId } };
}
