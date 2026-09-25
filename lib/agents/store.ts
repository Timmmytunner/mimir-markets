import { consumeNonce as consumeNonceFromStore } from "@/lib/server/nonce-store";
import { getAgentApiResponse, getAgentRecord, insertAgentRequestAudit, saveAgentApiResponse, upsertAgentRecord } from "@/lib/db";
import type { AgentRecord } from "./registry";

declare global {
  // eslint-disable-next-line no-var
  var __mimirAgentRecords: Map<string, AgentRecord> | undefined;
  // eslint-disable-next-line no-var
  var __mimirAgentResponses: Map<string, { body: unknown; status: number }> | undefined;
}

const records = globalThis.__mimirAgentRecords ??= new Map<string, AgentRecord>();
const responses = globalThis.__mimirAgentResponses ??= new Map();
const responseKey = (agentId: string, action: string, key: string) => `${agentId}:${action}:${key}`;

export async function saveAgent(agent: AgentRecord): Promise<void> {
  records.set(agent.agentId, agent);
  await upsertAgentRecord(agent).catch(() => undefined);
}

export async function loadAgent(agentId: string): Promise<AgentRecord | null> {
  try {
    const durable = await getAgentRecord(agentId);
    if (durable) records.set(agentId, durable);
    return durable ?? records.get(agentId) ?? null;
  } catch {
    return records.get(agentId) ?? null;
  }
}

/**
 * Consume a nonce for replay protection.
 *
 * Delegates to `lib/server/nonce-store` which provides:
 *  - Durable `agent_api_nonces` rows with a per-row `expires_at` so old nonces
 *    are prunable and the table does not grow forever.
 *  - A bounded in-process cache (LRU, capped at NONCE_CACHE_MAX) that
 *    short-circuits DB round-trips for same-instance replays.
 *
 * The `at` parameter (ms) is the request timestamp used as `consumed_at` in the
 * DB row. Retaining it here keeps the call-site signature stable.
 */
export async function consumeNonce(agentId: string, nonce: string, at: number): Promise<boolean> {
  return consumeNonceFromStore(agentId, nonce, at);
}

export async function auditAgentRequest(row: Parameters<typeof insertAgentRequestAudit>[0]): Promise<void> {
  await insertAgentRequestAudit(row).catch(() => undefined);
}

export async function loadIdempotentResponse(agentId: string, action: string, key: string) {
  try {
    return await getAgentApiResponse(agentId, action, key) ?? responses.get(responseKey(agentId, action, key)) ?? null;
  } catch { return responses.get(responseKey(agentId, action, key)) ?? null; }
}

export async function saveIdempotentResponse(agentId: string, action: string, key: string, body: unknown, status = 200) {
  responses.set(responseKey(agentId, action, key), { body, status });
  await saveAgentApiResponse({ agentId, action, idempotencyKey: key, body, status, createdAt: Date.now() }).catch(() => undefined);
}
