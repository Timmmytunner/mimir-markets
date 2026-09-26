import assert from "node:assert/strict";
import test from "node:test";
import { Keypair } from "@stellar/stellar-sdk";

interface PermissionDbRow {
  permission_id: string;
  owner_wallet: string;
  execution_agent_id: string;
  signal_agent_id: string;
  policy_json: string;
  signed_policy_hash: string;
  status: string;
  created_at: number;
  updated_at: number;
  revoked_at?: number | null;
}

const permissionsTable = new Map<string, PermissionDbRow>();
const executionsTable: Array<Record<string, unknown>> = [];

function installFakePool(): void {
  const handler = async (sql: string, args: unknown[] = []) => {
    const s = sql.trim();
    if (s.includes("INSERT INTO copy_permissions")) {
      const [permission_id, owner_wallet, execution_agent_id, signal_agent_id, policy_json, signed_policy_hash, status, at] = args as any[];
      const existing = permissionsTable.get(permission_id);
      const row: PermissionDbRow = {
        permission_id,
        owner_wallet,
        execution_agent_id,
        signal_agent_id,
        policy_json,
        signed_policy_hash,
        status,
        created_at: existing ? existing.created_at : Number(at),
        updated_at: Number(at),
        revoked_at: status === "revoked" ? Number(at) : existing?.revoked_at ?? null,
      };
      permissionsTable.set(permission_id, row);
      return { rows: [] };
    }
    if (s.includes("FROM copy_permissions") && s.includes("permission_id =")) {
      const permId = args[0] as string;
      const row = permissionsTable.get(permId);
      if (!row) return { rows: [] };
      return {
        rows: [{
          policy_json: row.policy_json,
          signed_policy_hash: row.signed_policy_hash,
          status: row.status,
        }],
      };
    }
    if (s.includes("FROM copy_executions") && s.includes("permission_id =")) {
      const permId = args[0] as string;
      const rows = executionsTable.filter((e) => e.permission_id === permId);
      return { rows };
    }
    return { rows: [] };
  };

  const pool = {
    query: (sql: string, args: unknown[] = []) => handler(sql, args),
    connect: async () => ({
      query: (sql: string, args: unknown[] = []) => handler(sql, args),
      release: () => {},
    }),
  };

  process.env.DATABASE_URL = "postgres://fake/mimir";
  const g = globalThis as unknown as Record<string, unknown>;
  g.__mimirDbPool = pool;
  g.__mimirDbReady = Promise.resolve(pool);
}

installFakePool();

import { POST, GET, DELETE } from "../../app/api/copy/permissions/route";
import { copyPolicyHash, type CopyPermission } from "../../lib/copy-trading";
import { getUsdcSacId } from "../../lib/stellar";
import { configuredSpender } from "../../lib/agents/spend-permissions";

const ownerKeypair = Keypair.random();
const OWNER = ownerKeypair.publicKey();

// Ensure configured USDC and Spender match runtime test defaults if present
const USDC = getUsdcSacId() || "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const SPENDER = configuredSpender() || "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI";

function policyMessage(permission: Omit<CopyPermission, "signedPolicyHash">): string {
  const hash = copyPolicyHash(permission);
  return `Mimir copy permission\npermission: ${permission.permissionId}\nowner: ${permission.ownerWallet}\npolicyHash: ${hash}`;
}

function makeUnsignedPermission(id = "route-test-perm-1", owner = OWNER): Omit<CopyPermission, "signedPolicyHash"> {
  return {
    permissionId: id,
    ownerWallet: owner,
    executionAgentId: "agent-exec-1",
    signalAgentId: "agent-signal-1",
    maxPerPositionUsdc: 5,
    dailyCapUsdc: 20,
    weeklyCapUsdc: 50,
    totalOpenExposureUsdc: 30,
    maxRealizedLossAtomic: "100000000",
    allowedCategories: ["crypto"],
    allowedModes: ["pool"],
    minConfidenceBps: 7000,
    minPayoutBps: 12000,
    expiresAt: Date.now() + 86_400_000,
    depth: 1,
    status: "active",
    spendPermission: {
      token: USDC,
      spender: SPENDER,
      allowanceAtomic: 1000000000n,
      periodSeconds: 86400,
    },
  };
}

function signPermission(permission: Omit<CopyPermission, "signedPolicyHash">, signer: Keypair = ownerKeypair): string {
  const msg = policyMessage(permission);
  return signer.sign(Buffer.from(msg, "utf8")).toString("base64");
}

function jsonRequest(url: string, method: string, body?: unknown): Request {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    body: body !== undefined ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined,
  });
}

test("POST /api/copy/permissions: rejects malformed JSON and oversized payloads", async () => {
  const malformed = await POST(jsonRequest("http://localhost/api/copy/permissions", "POST", "{"));
  assert.equal(malformed.status, 400);

  const oversized = await POST(jsonRequest("http://localhost/api/copy/permissions", "POST", " ".repeat(16_385)));
  assert.equal(oversized.status, 413);

  const missing = await POST(jsonRequest("http://localhost/api/copy/permissions", "POST", {}));
  assert.equal(missing.status, 400);
});

test("POST /api/copy/permissions: enforces token, spender, budget and signature checks", async () => {
  const perm = makeUnsignedPermission("perm-reject-checks");

  // Wrong token if configured
  if (getUsdcSacId()) {
    const wrongTokenPerm = {
      ...perm,
      spendPermission: { ...perm.spendPermission, token: "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI" },
    };
    const wrongTokenSig = signPermission(wrongTokenPerm);
    const res = await POST(
      jsonRequest("http://localhost/api/copy/permissions", "POST", {
        permission: {
          ...wrongTokenPerm,
          spendPermission: { ...wrongTokenPerm.spendPermission, allowanceAtomic: "1000000000" },
        },
        signature: wrongTokenSig,
      }),
    );
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, "wrong_token");
  }

  // Invalid budget (daily cap less than position cap)
  const badBudgetPerm = { ...perm, dailyCapUsdc: 2, maxPerPositionUsdc: 5 };
  const badBudgetSig = signPermission(badBudgetPerm);
  const badBudgetRes = await POST(
    jsonRequest("http://localhost/api/copy/permissions", "POST", {
      permission: {
        ...badBudgetPerm,
        spendPermission: { ...badBudgetPerm.spendPermission, allowanceAtomic: "1000000000" },
      },
      signature: badBudgetSig,
    }),
  );
  assert.equal(badBudgetRes.status, 400);

  // Invalid signature
  const validSig = signPermission(perm);
  const invalidSigRes = await POST(
    jsonRequest("http://localhost/api/copy/permissions", "POST", {
      permission: {
        ...perm,
        spendPermission: { ...perm.spendPermission, allowanceAtomic: "1000000000" },
      },
      signature: "YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXoxMjM0NTY3ODkw",
    }),
  );
  assert.equal(invalidSigRes.status, 401);
});

test("POST /api/copy/permissions: stores valid permission and returns contract feedback", async () => {
  const perm = makeUnsignedPermission("perm-valid-store-1");
  const sig = signPermission(perm);

  const res = await POST(
    jsonRequest("http://localhost/api/copy/permissions", "POST", {
      permission: {
        ...perm,
        spendPermission: { ...perm.spendPermission, allowanceAtomic: "1000000000" },
      },
      signature: sig,
    }),
  );

  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const body = await res.json();
  assert.equal(body.permission.permissionId, "perm-valid-store-1");
  assert.equal(body.worstCase.perPositionUsdc, 5);
  assert.ok(body.feedback);
  assert.equal(body.feedback.permissionId, "perm-valid-store-1");
  assert.equal(body.feedback.ownerWallet, OWNER);
});

test("GET /api/copy/permissions: returns 400 when missing permissionId", async () => {
  const missing = await GET(jsonRequest("http://localhost/api/copy/permissions", "GET"));
  assert.equal(missing.status, 400);
  const body = await missing.json();
  assert.equal(body.error, "permissionId required");

  const empty = await GET(jsonRequest("http://localhost/api/copy/permissions?permissionId=   ", "GET"));
  assert.equal(empty.status, 400);
});

test("GET /api/copy/permissions: retrieves executions by permissionId", async () => {
  const res = await GET(jsonRequest("http://localhost/api/copy/permissions?permissionId=perm-valid-store-1", "GET"));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const body = await res.json();
  assert.equal(body.permissionId, "perm-valid-store-1");
  assert.ok(Array.isArray(body.executions));
});

test("DELETE /api/copy/permissions: rejects invalid signature and revokes with valid signature", async () => {
  const permId = "perm-valid-store-1";
  const revokeMsg = `Mimir revoke copy permission\npermission: ${permId}\nowner: ${OWNER}`;

  // Invalid signature
  const badSig = await DELETE(
    jsonRequest("http://localhost/api/copy/permissions", "DELETE", {
      permissionId: permId,
      signature: "YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXoxMjM0NTY3ODkw",
    }),
  );
  assert.equal(badSig.status, 401);

  // Valid signature
  const validRevokeSig = ownerKeypair.sign(Buffer.from(revokeMsg, "utf8")).toString("base64");
  const revokeRes = await DELETE(
    jsonRequest("http://localhost/api/copy/permissions", "DELETE", {
      permissionId: permId,
      signature: validRevokeSig,
    }),
  );
  assert.equal(revokeRes.status, 200);
  const revokeBody = await revokeRes.json();
  assert.equal(revokeBody.status, "revoked");
  assert.equal(revokeBody.feedback.status, "revoked");

  // Re-fetch executions should still succeed
  const reGet = await GET(jsonRequest(`http://localhost/api/copy/permissions?permissionId=${permId}`, "GET"));
  assert.equal(reGet.status, 200);
  const reGetBody = await reGet.json();
  assert.equal(reGetBody.permissionId, permId);
  assert.ok(Array.isArray(reGetBody.executions));
});
