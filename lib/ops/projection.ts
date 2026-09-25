/**
 * Chain events → read-index rows.
 *
 * The guarantee this module exists to make testable: **the read-index is a pure
 * function of chain events.** Delete Postgres entirely, replay the logs from the
 * deploy block, and you get byte-identical rows. That is what makes the index a
 * cache rather than a second source of truth — and the only way to keep believing
 * it is to test it, which is why the fold is pure and lives here instead of inside
 * the writer.
 *
 * Three properties, each tested:
 *
 *   deterministic  the same events always produce the same rows
 *   idempotent     replaying an event changes nothing
 *   reorg-safe     a later block's version of a fact wins, and an event that was
 *                  reorged out and replaced does not leave its effect behind
 *
 * Ordering matters and is NOT the array order: events arrive from concurrent
 * Soroban RPC `getEvents` pages, so they are sorted by (blockNumber, logIndex)
 * before the fold. Trusting arrival order would make the index depend on RPC
 * scheduling.
 *
 * Those two field names are transport-agnostic ordinals, deliberately kept: on
 * Stellar they carry the ledger sequence and the event's index within it. They read
 * as EVM vocabulary, but renaming them would be a rename of the pure fold's public
 * shape for no behavioural gain — and this module's whole value is that the fold is
 * stable enough to test.
 */

export type ChainEventName =
  | "ClaimCreated"
  | "ClaimChallenged"
  | "ClaimResolved"
  | "ClaimCancelled";

/** The position of a log in the chain. The dedup and reorg key. */
export interface LogPosition {
  blockNumber: number;
  logIndex: number;
  /** Present once the block is known; used to detect a reorged-out log. */
  blockHash?: string;
  transactionHash?: string;
}

export interface ChainEvent extends LogPosition {
  name: ChainEventName;
  claimId: number;
  /** ClaimCreated */
  creator?: string;
  category?: string;
  /** ClaimChallenged */
  challenger?: string;
  stakeUnits?: bigint;
  /** ClaimResolved */
  winnerSide?: 0 | 1 | 2 | 3 | 4;
  confidence?: number;
  evidenceHash?: string;
}

export type ProjectedState = "open" | "active" | "resolved" | "cancelled";

export interface ProjectedChallenger {
  address: string;
  stakeUnits: bigint;
}

export interface ProjectedClaim {
  claimId: number;
  creator: string;
  category: string;
  state: ProjectedState;
  challengers: ProjectedChallenger[];
  totalChallengerStakeUnits: bigint;
  winnerSide: number;
  confidence: number;
  evidenceHash: string | null;
  /** Block of the newest event applied. Lets a resync resume from here. */
  lastBlock: number;
  lastLogIndex: number;
  /** Terminal states never change again, so they can be cached indefinitely. */
  isFinal: boolean;
}

export interface ProjectionResult {
  claims: Map<number, ProjectedClaim>;
  /** Highest block fully folded, for the sync cursor. */
  headBlock: number;
  /** Events skipped as already applied. A non-zero count is normal on a resync. */
  duplicatesSkipped: number;
  /** Events referring to a claim with no ClaimCreated — a genuine gap. */
  orphanEvents: number;
}

/** Stable identity for a log. Two logs cannot share this. */
export function eventKey(position: LogPosition): string {
  return `${position.blockNumber}:${position.logIndex}`;
}

/**
 * Canonical order: block, then log index within the block.
 *
 * Never the array order. Events come back from concurrent getLogs chunks, so
 * folding in arrival order would make the index depend on RPC scheduling.
 */
export function compareEvents(a: LogPosition, b: LogPosition): number {
  if (a.blockNumber !== b.blockNumber) return a.blockNumber - b.blockNumber;
  return a.logIndex - b.logIndex;
}

function isFinalState(state: ProjectedState): boolean {
  return state === "resolved" || state === "cancelled";
}

/**
 * Fold events into read-index rows.
 *
 * `reorgedOut` lets a resync drop logs whose block hash no longer matches the
 * canonical chain. Without it a reorged-out challenge would leave its stake in the
 * index forever, and the pool totals would silently disagree with the contract.
 */
export function project(
  events: ChainEvent[],
  opts: { reorgedOut?: ReadonlySet<string> } = {},
): ProjectionResult {
  const reorgedOut = opts.reorgedOut ?? new Set<string>();
  const claims = new Map<number, ProjectedClaim>();
  const applied = new Set<string>();

  let headBlock = 0;
  let duplicatesSkipped = 0;
  let orphanEvents = 0;

  const ordered = [...events]
    .filter((event) => !(event.blockHash && reorgedOut.has(event.blockHash)))
    .sort(compareEvents);

  for (const event of ordered) {
    const key = eventKey(event);
    // Idempotency: a resync overlapping an already-folded range is normal, and
    // re-applying a challenge would double a stake.
    if (applied.has(key)) {
      duplicatesSkipped += 1;
      continue;
    }
    applied.add(key);
    headBlock = Math.max(headBlock, event.blockNumber);

    if (event.name === "ClaimCreated") {
      // A creation seen twice for one id is the same log arriving twice; the
      // dedup above already handled it, so this is a genuine duplicate id and the
      // first creation wins.
      if (!claims.has(event.claimId)) {
        claims.set(event.claimId, {
          claimId: event.claimId,
          // Stellar strkeys are case-sensitive. Preserve them byte-for-byte so a
          // replay cannot manufacture an address that the chain does not know.
          creator: event.creator ?? "",
          category: event.category ?? "custom",
          state: "open",
          challengers: [],
          totalChallengerStakeUnits: 0n,
          winnerSide: 0,
          confidence: 0,
          evidenceHash: null,
          lastBlock: event.blockNumber,
          lastLogIndex: event.logIndex,
          isFinal: false,
        });
      }
      continue;
    }

    const claim = claims.get(event.claimId);
    if (!claim) {
      // An event for a claim we never saw created means the scan started after
      // the creation. Counted, not silently dropped, so a gap is visible.
      orphanEvents += 1;
      continue;
    }

    switch (event.name) {
      case "ClaimChallenged": {
        const address = event.challenger ?? "";
        const stakeUnits = event.stakeUnits ?? 0n;
        // One address challenges at most once per claim on chain, so a repeat is
        // data corruption rather than a second position — keep the first.
        if (!claim.challengers.some((entry) => entry.address === address)) {
          claim.challengers.push({ address, stakeUnits });
          claim.totalChallengerStakeUnits += stakeUnits;
        }
        // A resolved claim cannot go back to active.
        if (!isFinalState(claim.state)) claim.state = "active";
        break;
      }
      case "ClaimResolved":
        claim.state = "resolved";
        claim.winnerSide = event.winnerSide ?? 0;
        claim.confidence = event.confidence ?? 0;
        claim.evidenceHash = event.evidenceHash ?? null;
        claim.isFinal = true;
        break;
      case "ClaimCancelled":
        claim.state = "cancelled";
        claim.isFinal = true;
        break;
    }

    claim.lastBlock = event.blockNumber;
    claim.lastLogIndex = event.logIndex;
  }

  // Challenger order is normalised so two replays of the same events produce
  // byte-identical rows regardless of the order the chunks arrived in.
  for (const claim of claims.values()) {
    claim.challengers.sort((a, b) => a.address.localeCompare(b.address));
  }

  return { claims, headBlock, duplicatesSkipped, orphanEvents };
}

/**
 * A stable fingerprint of the projected state, for comparing a rebuild against
 * the live index. Equality here is the rebuild guarantee.
 */
export function projectionFingerprint(result: ProjectionResult): string {
  const rows = [...result.claims.values()].sort((a, b) => a.claimId - b.claimId);
  return rows
    .map((claim) =>
      [
        claim.claimId,
        claim.creator,
        claim.category,
        claim.state,
        claim.winnerSide,
        claim.confidence,
        claim.evidenceHash ?? "",
        claim.totalChallengerStakeUnits.toString(),
        claim.challengers.map((c) => `${c.address}=${c.stakeUnits}`).join(","),
      ].join("|"),
    )
    .join("\n");
}

/**
 * Where a resync should resume.
 *
 * One block BEHIND the head on purpose: the last block may have been partially
 * scanned when a chunked fetch was cut short, and re-folding a block is free
 * because the fold is idempotent. Resuming at head+1 could skip a log.
 */
export function resumeFromBlock(result: ProjectionResult, deployBlock: number): number {
  if (result.headBlock === 0) return deployBlock;
  return Math.max(deployBlock, result.headBlock - 1);
}
