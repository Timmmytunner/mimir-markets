/**
 * Deterministic fixtures for x402 payment-proof verification and its load limits.
 *
 * Everything here runs entirely offline: keypairs are fixed secrets, transaction
 * hashes come from a seeded PRNG, and Horizon is replaced by an in-memory reader
 * behind the `StellarHorizonReader` seam in `lib/x402/stellar-scheme.ts`. A load
 * test can therefore verify and settle thousands of payments per second without
 * a network, reproducing the same verdict every run.
 *
 * This is test/script shared code, never shipped to the app: only the loader
 * under `scripts/` and the `tests/node/*.test.ts` suites import it.
 */

import { Keypair } from "@stellar/stellar-sdk";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";

import { X402_ASSET, X402_NETWORK, X402_SCHEME } from "../../lib/x402/config";
import {
  STELLAR_PROOF_KIND,
  consumeSettlement,
  consumedSettlementsCount,
  isSettlementConsumed,
  parsePaymentProof,
  paymentProofMessage,
  proofPayer,
  resetConsumedSettlements,
  verifyStellarPayment,
  type HorizonPaymentOperation,
  type StellarHorizonReader,
  type StellarPaymentProof,
} from "../../lib/x402/stellar-scheme";

export { parsePaymentProof, proofPayer } from "../../lib/x402/stellar-scheme";

// ── Fixed keypairs ────────────────────────────────────────────────────────────
// Deriving deterministic keypairs from these secret seeds is what makes the load
// run reproducible from a clean checkout. They are test fixtures, not secrets
// that gate anything — a proof is a payment this fixture also manufactures.

/** Payer for the payments a proof claims to have been made. */
export const FIXTURE_PAYER_SECRET = "SAWXMSQ6ETHTU2HSVKCYV6IHLZWLSYNVN2INLVISMUNOZ7K5RI7VRSLD";
/** A second payer, for "another account cannot claim this payment" cases. */
export const FIXTURE_SECOND_PAYER_SECRET = "SAQUIBDCUPTDWPYLRZIIFKAWVIR3CGGILCWXILG3KMCY7NAF44YLG5DD";
/** The seller each proof pays, in this fixture's ledger. */
export const FIXTURE_SELLER_PUBLIC = "GCM6HPMQQISWED5UCTWXQOBXBPTOFLRKMUSZOEB6L5QMP2DMKJSLJXIJ";

/**
 * A valid `C…` contract StrKey (from `StrKey.encodeContract(fill(0x07))`), used
 * for the "a classic payment cannot target a contract" refusal.
 */
export const FIXTURE_CONTRACT_PAYTO = "CADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP5KR";

export const FIXTURE_PAYER = Keypair.fromSecret(FIXTURE_PAYER_SECRET);
export const FIXTURE_SECOND_PAYER = Keypair.fromSecret(FIXTURE_SECOND_PAYER_SECRET);

/** "CODE:ISSUER" is assembled upstream; split it to match Horizon records. */
export const FIXTURE_ASSET_CODE = X402_ASSET.split(":")[0]!;
export const FIXTURE_ASSET_ISSUER = X402_ASSET.split(":")[1]!;

// ── Deterministic transaction hashes ─────────────────────────────────────────

const HASH_SEQUENCE_SEED = 0x4020_4021;
let hashRngState = HASH_SEQUENCE_SEED;

/**
 * Rewind the fixture hash stream to its seed. Every load run starts here, so the
 * same `count` produces the same hashes on every invocation — and a second run
 * in the same process re-uses the first run's hashes, which is exactly why the
 * caller must also reset settlement state between runs.
 */
export function resetTxHashSequence(): void {
  hashRngState = HASH_SEQUENCE_SEED;
}

/** Next 64-char lowercase hex hash from the seeded PRNG. */
export function nextTxHash(): string {
  hashRngState |= 0;
  hashRngState = (hashRngState + 0x6d2b79f5) | 0;
  let t = Math.imul(hashRngState ^ (hashRngState >>> 15), 1 | hashRngState);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0).toString(16).padStart(8, "0").repeat(8);
}

// ── The quote a load run pays against ────────────────────────────────────────

export function makeRequirements(overrides: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return {
    scheme: X402_SCHEME,
    network: X402_NETWORK,
    asset: X402_ASSET,
    amount: "10000", // $0.001 at 7 decimals — a premiumPrice-quote-sized payment
    payTo: FIXTURE_SELLER_PUBLIC,
    maxTimeoutSeconds: 300,
    extra: {},
    ...overrides,
  };
}

// ── A landed payment, as Horizon would report it ──────────────────────────────

export interface LandedPayment {
  transaction: string;
  createdAtMs: number;
  successful: boolean;
  operations: HorizonPaymentOperation[];
}

export function landedPayment(opts: {
  transaction?: string;
  /** Atomic USDC moved by the payment operation(s). Defaults to the quote. */
  amountAtomic?: bigint;
  from?: string;
  to?: string;
  createdAtMs?: number;
  successful?: boolean;
  operations?: HorizonPaymentOperation[];
} = {}): LandedPayment {
  const transaction = (opts.transaction ?? nextTxHash()).toLowerCase();
  const from = opts.from ?? FIXTURE_PAYER.publicKey();
  const to = opts.to ?? FIXTURE_SELLER_PUBLIC;
  const amountAtomic = opts.amountAtomic ?? 10_000n;
  const createdAtMs = opts.createdAtMs ?? Date.now() - 5_000;
  const successful = opts.successful ?? true;
  const operations =
    opts.operations ??
    [
      {
        type: "payment",
        from,
        to,
        asset_type: "credit_alphanum4",
        asset_code: FIXTURE_ASSET_CODE,
        asset_issuer: FIXTURE_ASSET_ISSUER,
        amount: (Number(amountAtomic) / 10_000_000).toFixed(7),
        transaction_successful: true,
      },
    ];
  return { transaction, createdAtMs, successful, operations };
}

// ── Offline Horizon reader (the `StellarHorizonReader` seam) ─────────────────

export interface FakeHorizon extends StellarHorizonReader {
  /** Every landed payment this fixture ledger knows, keyed by lowercased hash. */
  records: Map<string, LandedPayment>;
  /** Read counts, so a load run can assert each payment was read exactly once. */
  reads: { getTransaction: number; getPaymentOperations: number };
}

/**
 * An in-memory Horizon. Missing transactions throw with `response.status ===
 * 404` — exactly what the scheme's distinguished `transaction_not_found`
 * handling looks for — while `failReads` makes reads throw a generic error,
 * which verification maps to `horizon_unavailable`.
 */
export function fakeHorizonBackend(records: LandedPayment[] = [], failReads = false): FakeHorizon {
  const byHash = new Map(records.map((r) => [r.transaction.toLowerCase(), r]));
  const reads = { getTransaction: 0, getPaymentOperations: 0 };

  const missingError = (): Error & { response?: { status: number } } => {
    const error = new Error("resource missing (fixture)") as Error & { response?: { status: number } };
    error.response = { status: 404 };
    return error;
  };

  return {
    records: byHash,
    reads,
    async getTransaction(hash) {
      reads.getTransaction += 1;
      if (failReads) throw new Error("Horizon is down (fixture)");
      const record = byHash.get(hash.toLowerCase());
      if (!record) throw missingError();
      return { createdAtMs: record.createdAtMs, successful: record.successful };
    },
    async getPaymentOperations(hash) {
      reads.getPaymentOperations += 1;
      if (failReads) throw new Error("Horizon is down (fixture)");
      const record = byHash.get(hash.toLowerCase());
      if (!record) throw missingError();
      return record.operations;
    },
  };
}

// ── Proofs ────────────────────────────────────────────────────────────────────

/**
 * A payment proof a fixture payer would actually produce: signed over the exact
 * canonical message the quote dictates. Every negative case starts by mutating
 * this and re-signing, so a refusal cannot be a "the signature was never valid"
 * false positive.
 */
export function signedProof(
  transaction: string,
  requirements: PaymentRequirements,
  payer: Keypair = FIXTURE_PAYER,
): StellarPaymentProof {
  const message = paymentProofMessage({
    network: requirements.network,
    transaction,
    payTo: requirements.payTo,
    amount: requirements.amount,
    asset: requirements.asset,
  });
  return {
    kind: STELLAR_PROOF_KIND,
    network: requirements.network,
    transaction: transaction.toLowerCase(),
    payer: payer.publicKey(),
    signature: payer.sign(Buffer.from(message, "utf8")).toString("base64"),
  };
}

export function toPaymentPayload(
  proof: StellarPaymentProof,
  requirements: PaymentRequirements,
): PaymentPayload {
  return {
    x402Version: 2,
    accepted: requirements,
    payload: proof as unknown as Record<string, unknown>,
  };
}

// ── Verify / settle atoms, re-exported for the load scripts and tests ─────────

export const verifyWithBackend = (
  proof: unknown,
  requirements: PaymentRequirements,
  backend: StellarHorizonReader,
  options: { maxAgeMs: number; now: number },
) =>
  verifyStellarPayment(proof as Readonly<Record<string, unknown>>, requirements, {
    maxAgeMs: options.maxAgeMs,
    now: options.now,
    backend,
  });

export const settleFixtures = {
  consume: consumeSettlement,
  inspect: isSettlementConsumed,
  reset: resetConsumedSettlements,
  count: consumedSettlementsCount,
};

// ── The load run ──────────────────────────────────────────────────────────────

export interface X402LoadStats {
  count: number;
  concurrency: number;
  verifiedOk: number;
  settledOk: number;
  replaysRefused: number;
  durationMs: number;
  verificationsPerSecond: number;
  txReads: number;
  opsReads: number;
  consumedAfter: number;
  /** The exact hashes this run used, for replay assertions after the run. */
  transactions: string[];
}

export interface X402LoadOptions {
  /** Distinct payments to verify and settle. */
  count?: number;
  /** Parallel verification workers. */
  concurrency?: number;
  now?: number;
  maxAgeMs?: number;
}

/**
 * Verify `count` distinct proofs against their own fixture payments, settle each
 * once, then confirm exactly-once replay: every hash can buy exactly one
 * response. Correctness is what is asserted, never wall-clock; throughput is
 * reported so an operator can eyeball the capacity number. Each verification
 * must be answered by exactly one Horizon transaction read and one operations
 * read — proof that a busy instance still reads *its* payment, not a shared one.
 *
 * Throws with a descriptive message on any deviation, so CI fails loudly.
 */
export async function runX402Load(opts: X402LoadOptions = {}): Promise<X402LoadStats> {
  const count = opts.count ?? 1_000;
  const concurrency = opts.concurrency ?? 50;
  const maxAgeMs = opts.maxAgeMs ?? 5 * 60 * 1000;
  const now = opts.now ?? Date.now();

  // Deterministic per run: the tests compare two runs and expect identical
  // hashes (and therefore identical settlement decisions).
  resetTxHashSequence();

  const requirements = makeRequirements();
  const payments = Array.from({ length: count }, () => {
    const transaction = nextTxHash();
    return { transaction, proof: signedProof(transaction, requirements) };
  });
  const backend = fakeHorizonBackend(
    payments.map(({ transaction }) =>
      landedPayment({ transaction, createdAtMs: now - 2_000, amountAtomic: 10_000n }),
    ),
  );

  const started = performance.now();
  let verifiedOk = 0;

  const verifyOne = async (transaction: string, proof: StellarPaymentProof): Promise<void> => {
    const result = await verifyWithBackend(proof, requirements, backend, { maxAgeMs, now });
    if (!result.ok) {
      throw new Error(`verification ${transaction} refused: ${result.reason}: ${result.message}`);
    }
    verifiedOk += 1;
  };

  // Bounded worker pool so a huge count never holds thousands of promises open.
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, count)) }, async () => {
    for (;;) {
      const i = cursor;
      cursor += 1;
      if (i >= count) return;
      await verifyOne(payments[i]!.transaction, payments[i]!.proof);
    }
  });
  await Promise.all(workers);

  let settledOk = 0;
  for (const { transaction } of payments) {
    if (!(await settleFixtures.consume(requirements.network, transaction))) {
      throw new Error(`fresh hash ${transaction} was refused settlement`);
    }
    settledOk += 1;
    if (!(await settleFixtures.inspect(requirements.network, transaction))) {
      throw new Error(`replay of just-settled ${transaction} was allowed`);
    }
  }

  const durationMs = performance.now() - started;

  if (verifiedOk !== count) throw new Error(`expected ${count} verified, saw ${verifiedOk}`);
  if (settledOk !== count) throw new Error(`expected ${count} settled, saw ${settledOk}`);
  if (backend.reads.getTransaction !== count) {
    throw new Error(`expected ${count} transaction reads, saw ${backend.reads.getTransaction}`);
  }
  if (backend.reads.getPaymentOperations !== count) {
    throw new Error(`expected ${count} operations reads, saw ${backend.reads.getPaymentOperations}`);
  }

  return {
    count,
    concurrency,
    verifiedOk,
    settledOk,
    replaysRefused: count,
    durationMs,
    verificationsPerSecond: count / (durationMs / 1000),
    txReads: backend.reads.getTransaction,
    opsReads: backend.reads.getPaymentOperations,
    consumedAfter: settleFixtures.count(),
    transactions: payments.map(({ transaction }) => transaction),
  };
}