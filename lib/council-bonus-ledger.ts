/** Durable, at-most-once reservation for off-contract council bonuses. */
import { getDb } from "./db";

export interface CouncilBonusKey {
  network: string;
  contractId: string;
  claimId: number;
  jurorSlug: string;
}

export interface CouncilBonusReservation extends CouncilBonusKey {
  recipient: string;
  amountAtomic: bigint;
  settlementTxHash: string;
}

export async function reserveCouncilBonus(row: CouncilBonusReservation): Promise<boolean> {
  const db = await getDb();
  const now = Date.now();
  const result = await db.query(
    `INSERT INTO council_bonus_payouts (
      network, contract_id, claim_id, juror_slug, recipient, amount_atomic,
      settlement_tx_hash, status, created_at, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'reserved', $8, $8)
    ON CONFLICT (network, contract_id, claim_id, juror_slug) DO NOTHING
    RETURNING claim_id`,
    [row.network, row.contractId, row.claimId, row.jurorSlug, row.recipient,
      row.amountAtomic.toString(), row.settlementTxHash, now],
  );
  if (result.rows.length === 1) return true;
  const existing = await db.query(
    `SELECT recipient, amount_atomic, settlement_tx_hash
     FROM council_bonus_payouts
     WHERE network = $1 AND contract_id = $2 AND claim_id = $3 AND juror_slug = $4`,
    [row.network, row.contractId, row.claimId, row.jurorSlug],
  );
  const stored = existing.rows[0];
  if (!stored || stored.recipient !== row.recipient ||
      String(stored.amount_atomic) !== row.amountAtomic.toString() ||
      stored.settlement_tx_hash !== row.settlementTxHash) {
    throw new Error("conflicting council bonus reservation");
  }
  return false;
}

export async function recordCouncilBonusResult(
  key: CouncilBonusKey,
  paymentTxHash: string | null,
): Promise<void> {
  const db = await getDb();
  const result = await db.query(
    `UPDATE council_bonus_payouts
     SET status = $5, payment_tx_hash = $6, updated_at = $7
     WHERE network = $1 AND contract_id = $2 AND claim_id = $3
       AND juror_slug = $4 AND status = 'reserved'`,
    [key.network, key.contractId, key.claimId, key.jurorSlug,
      paymentTxHash ? "confirmed" : "review", paymentTxHash, Date.now()],
  );
  if (result.rowCount !== 1) throw new Error("council bonus reservation was not updated");
}
