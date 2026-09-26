import { Buffer } from "node:buffer";
import { copyPolicyHash, validateCopyPermission, worstCaseCopySpend, type CopyPermission } from "@/lib/copy-trading";
import { getCopyPermission, listCopyExecutions, saveCopyPermission } from "@/lib/db";
import { verifyAgentSignature } from "@/lib/agents/signature";
import { configuredSpender } from "@/lib/agents/spend-permissions";
import { getUsdcSacId } from "@/lib/stellar";
import { evaluateCopyPermissionOnchain } from "@/lib/copy-permission-feedback";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BODY_BYTES = 16_384;

async function readJsonBody<T>(req: Request, maxBytes = MAX_BODY_BYTES): Promise<{ ok: true; data: T } | { ok: false; status: number; error: string }> {
  try {
    const reader = req.body?.getReader();
    if (!reader) {
      const text = await req.text();
      if (new TextEncoder().encode(text).length > maxBytes) {
        return { ok: false, status: 413, error: "request body too large" };
      }
      return { ok: true, data: JSON.parse(text) };
    }
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        return { ok: false, status: 413, error: "request body too large" };
      }
      chunks.push(value);
    }
    return { ok: true, data: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
  } catch {
    return { ok: false, status: 400, error: "invalid JSON" };
  }
}

/**
 * What the owner signs. The wallet is interpolated VERBATIM: a Stellar strkey is
 * case-sensitive base32, and `verifyAgentSignature` below is handed the unfolded
 * `permission.ownerWallet` as the verifying key.
 */
function policyMessage(permission: Omit<CopyPermission, "signedPolicyHash">): string {
  const hash = copyPolicyHash(permission);
  return `Mimir copy permission\npermission: ${permission.permissionId}\nowner: ${permission.ownerWallet}\npolicyHash: ${hash}`;
}

function jsonResponse(data: unknown, init?: ResponseInit): Response {
  const body = JSON.stringify(data, (_key, value) =>
    typeof value === "bigint" ? value.toString() : value,
  );
  return new Response(body, {
    ...init,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...init?.headers,
    },
  });
}

export async function POST(req: Request): Promise<Response> {
  const { authorizeRequest } = await import("@/lib/api/policy");
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || undefined;
  const gate = authorizeRequest("public_read", { route: "/api/copy/permissions", ip });
  if (!gate.allowed && gate.error) {
    return Response.json(gate.error.body, { status: gate.error.status, headers: gate.error.headers });
  }

  type JsonPermission = Omit<CopyPermission, "signedPolicyHash" | "spendPermission"> & {
    spendPermission: Omit<CopyPermission["spendPermission"], "allowanceAtomic"> & { allowanceAtomic: string | bigint };
  };

  const parsedBody = await readJsonBody<{ permission?: JsonPermission; signature?: string }>(req);
  if (!parsedBody.ok) {
    return jsonResponse({ error: parsedBody.error }, { status: parsedBody.status });
  }
  const body = parsedBody.data;

  if (!body.permission || !body.signature) {
    return jsonResponse({ error: "permission and signature required" }, { status: 400 });
  }

  let permission: Omit<CopyPermission, "signedPolicyHash">;
  try {
    permission = {
      ...body.permission,
      spendPermission: {
        ...body.permission.spendPermission,
        allowanceAtomic: BigInt(body.permission.spendPermission.allowanceAtomic),
      },
    };
  } catch {
    return jsonResponse({ error: "invalid_spend_permission" }, { status: 400 });
  }

  // Contract constraints on token and spender
  const expectedToken = getUsdcSacId();
  if (expectedToken && permission.spendPermission.token.trim() !== expectedToken.trim()) {
    return jsonResponse(
      { error: "wrong_token", detail: "permission token must match configured USDC SAC" },
      { status: 400 },
    );
  }
  const expectedSpender = configuredSpender();
  if (expectedSpender && permission.spendPermission.spender.trim() !== expectedSpender.trim()) {
    return jsonResponse(
      { error: "wrong_spender", detail: "permission spender must match configured spender" },
      { status: 400 },
    );
  }

  const validationError = validateCopyPermission(permission);
  if (validationError) {
    return jsonResponse({ error: validationError }, { status: 400 });
  }

  const signedPolicyHash = copyPolicyHash(permission);
  const valid = await verifyAgentSignature({
    address: permission.ownerWallet,
    message: policyMessage(permission),
    signature: body.signature,
  });
  if (!valid) {
    return jsonResponse({ error: "owner signature rejected" }, { status: 401 });
  }

  const record: CopyPermission = { ...permission, signedPolicyHash };
  await saveCopyPermission(record);

  const feedback = await evaluateCopyPermissionOnchain(record);
  return jsonResponse({
    permission: record,
    worstCase: worstCaseCopySpend(record),
    feedback,
  });
}

export async function DELETE(req: Request): Promise<Response> {
  const { authorizeRequest } = await import("@/lib/api/policy");
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || undefined;
  const gate = authorizeRequest("public_read", { route: "/api/copy/permissions", ip });
  if (!gate.allowed && gate.error) {
    return Response.json(gate.error.body, { status: gate.error.status, headers: gate.error.headers });
  }

  const parsedBody = await readJsonBody<{ permissionId?: string; signature?: string }>(req);
  if (!parsedBody.ok) {
    return jsonResponse({ error: parsedBody.error }, { status: parsedBody.status });
  }
  const body = parsedBody.data;

  const permissionId = body.permissionId?.trim();
  if (!permissionId || !body.signature) {
    return jsonResponse({ error: "permissionId and signature required" }, { status: 400 });
  }

  const permission = await getCopyPermission(permissionId);
  if (!permission) {
    return jsonResponse({ error: "permission not found" }, { status: 404 });
  }

  const message = `Mimir revoke copy permission\npermission: ${permission.permissionId}\nowner: ${permission.ownerWallet}`;
  const valid = await verifyAgentSignature({ address: permission.ownerWallet, message, signature: body.signature });
  if (!valid) {
    return jsonResponse({ error: "owner signature rejected" }, { status: 401 });
  }

  const revoked: CopyPermission = { ...permission, status: "revoked" };
  await saveCopyPermission(revoked);

  const feedback = await evaluateCopyPermissionOnchain(revoked);
  return jsonResponse({
    permissionId: revoked.permissionId,
    status: "revoked",
    feedback,
  });
}

export async function GET(req: Request): Promise<Response> {
  const { authorizeRequest } = await import("@/lib/api/policy");
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || undefined;
  const gate = authorizeRequest("public_read", { route: "/api/copy/permissions", ip });
  if (!gate.allowed && gate.error) {
    return Response.json(gate.error.body, { status: gate.error.status, headers: gate.error.headers });
  }

  const permissionId = new URL(req.url).searchParams.get("permissionId")?.trim();
  if (!permissionId) {
    return jsonResponse({ error: "permissionId required" }, { status: 400 });
  }

  const executions = await listCopyExecutions(permissionId, 100);
  return jsonResponse({
    permissionId,
    executions,
  });
}
