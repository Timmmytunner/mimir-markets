/**
 * The x402 seller's incident switch, kept out of `./server.ts` because that
 * module imports `server-only` and so cannot be loaded by the node test runner.
 * The route wrapper there is a thin shell around this decision.
 */

import { checkWriteAllowed } from "../ops/flags";

export interface SellingPausedResponse {
  status: 503;
  body: { error: string; detail?: string };
  headers: Record<string, string>;
}

/**
 * Null when paid endpoints may sell, otherwise the 503 to send instead.
 *
 * 503 + Retry-After rather than 402: a paying agent that sees a 402 will try to
 * pay, and a verifier that cannot read the ledger must refuse rather than guess.
 */
export function sellingPausedResponse(
  env: Record<string, string | undefined> = process.env,
): SellingPausedResponse | null {
  const gate = checkWriteAllowed({ capability: "x402_selling" }, env);
  if (gate.allowed) return null;
  return {
    status: 503,
    body: { error: "paid endpoints are temporarily unavailable", detail: gate.detail },
    headers: { "retry-after": "60" },
  };
}
