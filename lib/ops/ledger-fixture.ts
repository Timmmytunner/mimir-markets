import { readFile } from "node:fs/promises";
import { eventKey, project, projectionFingerprint, resumeFromBlock, type ChainEvent, type ChainEventName, type ProjectedClaim } from "./projection";

const EVENT_NAMES = new Set<ChainEventName>(["ClaimCreated", "ClaimChallenged", "ClaimResolved", "ClaimCancelled"]);
export interface LedgerFixture {
  version: 1; name: string; network: string; contractId: string;
  deployLedger: number; capturedThroughLedger: number; events: ChainEvent[];
  reorgedOut: string[]; expectedFingerprint: string;
}
export interface LedgerReplayArtifact {
  artifactVersion: 1; fixture: string;
  source: { network: string; contractId: string; deployLedger: number; capturedThroughLedger: number };
  reconciliation: { eventCount: number; claimCount: number; duplicatesSkipped: number; orphanEvents: number; headLedger: number; resumeFromLedger: number; fingerprint: string };
  rows: Array<Omit<ProjectedClaim, "challengers" | "totalChallengerStakeUnits"> & { totalChallengerStakeUnits: string; challengers: Array<{ address: string; stakeUnits: string }> }>;
}
function fail(path: string, message: string): never { throw new Error(`ledger fixture ${path}: ${message}`); }
function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(path, "must be an object");
  return value as Record<string, unknown>;
}
function text(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "") fail(path, "must be a non-empty string");
  return value;
}
function integer(value: unknown, path: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) fail(path, `must be a safe integer >= ${minimum}`);
  return value as number;
}
function optionalInteger(value: unknown, path: string): number | undefined { return value === undefined ? undefined : integer(value, path); }
function atomic(value: unknown, path: string): bigint | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^\d+$/.test(value)) fail(path, "must be an unsigned base-10 string");
  return BigInt(value);
}
function parseEvent(value: unknown, index: number): ChainEvent {
  const path = `events[${index}]`; const row = record(value, path);
  const name = text(row.name, `${path}.name`) as ChainEventName;
  if (!EVENT_NAMES.has(name)) fail(`${path}.name`, `unsupported event ${name}`);
  const winnerSide = optionalInteger(row.winnerSide, `${path}.winnerSide`);
  if (winnerSide !== undefined && winnerSide > 4) fail(`${path}.winnerSide`, "must be between 0 and 4");
  const event: ChainEvent = {
    name, claimId: integer(row.claimId, `${path}.claimId`, 1),
    blockNumber: integer(row.ledger, `${path}.ledger`, 1), logIndex: integer(row.eventIndex, `${path}.eventIndex`),
    blockHash: row.ledgerHash === undefined ? undefined : text(row.ledgerHash, `${path}.ledgerHash`),
    transactionHash: row.transactionHash === undefined ? undefined : text(row.transactionHash, `${path}.transactionHash`),
    creator: row.creator === undefined ? undefined : text(row.creator, `${path}.creator`),
    category: row.category === undefined ? undefined : text(row.category, `${path}.category`),
    challenger: row.challenger === undefined ? undefined : text(row.challenger, `${path}.challenger`),
    stakeUnits: atomic(row.stakeAtomic, `${path}.stakeAtomic`),
    winnerSide: winnerSide as ChainEvent["winnerSide"], confidence: optionalInteger(row.confidence, `${path}.confidence`),
    evidenceHash: row.evidenceHash === undefined ? undefined : text(row.evidenceHash, `${path}.evidenceHash`),
  };
  if (name === "ClaimCreated" && event.creator === undefined) fail(`${path}.creator`, "is required for ClaimCreated");
  if (name === "ClaimChallenged") {
    if (event.challenger === undefined) fail(`${path}.challenger`, "is required for ClaimChallenged");
    if (event.stakeUnits === undefined || event.stakeUnits <= 0n) fail(`${path}.stakeAtomic`, "must be greater than zero for ClaimChallenged");
  }
  if (name === "ClaimResolved" && event.winnerSide === undefined) fail(`${path}.winnerSide`, "is required for ClaimResolved");
  return event;
}
export function parseLedgerFixture(value: unknown): LedgerFixture {
  const root = record(value, "root");
  if (root.version !== 1) fail("version", "must equal 1");
  if (!Array.isArray(root.events)) fail("events", "must be an array");
  if (!Array.isArray(root.reorgedOut)) fail("reorgedOut", "must be an array");
  const fixture: LedgerFixture = {
    version: 1, name: text(root.name, "name"), network: text(root.network, "network"),
    contractId: text(root.contractId, "contractId"), deployLedger: integer(root.deployLedger, "deployLedger", 1),
    capturedThroughLedger: integer(root.capturedThroughLedger, "capturedThroughLedger", 1),
    events: root.events.map(parseEvent), reorgedOut: root.reorgedOut.map((entry, index) => text(entry, `reorgedOut[${index}]`)),
    expectedFingerprint: text(root.expectedFingerprint, "expectedFingerprint"),
  };
  const positions = new Map<string, string>();
  for (const event of fixture.events) {
    if (event.blockNumber < fixture.deployLedger || event.blockNumber > fixture.capturedThroughLedger) fail("events", `ledger ${event.blockNumber} is outside the declared capture range`);
    const key = eventKey(event);
    const serialized = JSON.stringify(event, (_key, item) => typeof item === "bigint" ? item.toString() : item);
    const prior = positions.get(key);
    if (prior !== undefined && prior !== serialized) fail("events", `conflicting events share ledger position ${key}`);
    positions.set(key, serialized);
  }
  return fixture;
}
export async function loadLedgerFixture(path: string): Promise<LedgerFixture> {
  let raw: string;
  try { raw = await readFile(path, "utf8"); }
  catch (error) { throw new Error(`cannot read ledger fixture ${path}: ${error instanceof Error ? error.message : String(error)}`); }
  try { return parseLedgerFixture(JSON.parse(raw)); }
  catch (error) { if (error instanceof SyntaxError) throw new Error(`ledger fixture ${path}: invalid JSON`); throw error; }
}
export function replayLedgerFixture(fixture: LedgerFixture): LedgerReplayArtifact {
  const result = project(fixture.events, { reorgedOut: new Set(fixture.reorgedOut) });
  const fingerprint = projectionFingerprint(result);
  if (result.orphanEvents > 0) throw new Error(`ledger replay refused: ${result.orphanEvents} orphan event(s); capture a complete range`);
  if (fingerprint !== fixture.expectedFingerprint) throw new Error("ledger replay refused: projection fingerprint differs from the reviewed fixture");
  const rows = [...result.claims.values()].sort((a, b) => a.claimId - b.claimId).map((claim) => ({
    ...claim, totalChallengerStakeUnits: claim.totalChallengerStakeUnits.toString(),
    challengers: claim.challengers.map((entry) => ({ ...entry, stakeUnits: entry.stakeUnits.toString() })),
  }));
  return {
    artifactVersion: 1, fixture: fixture.name,
    source: { network: fixture.network, contractId: fixture.contractId, deployLedger: fixture.deployLedger, capturedThroughLedger: fixture.capturedThroughLedger },
    reconciliation: { eventCount: fixture.events.length, claimCount: result.claims.size, duplicatesSkipped: result.duplicatesSkipped, orphanEvents: result.orphanEvents, headLedger: result.headBlock, resumeFromLedger: resumeFromBlock(result, fixture.deployLedger), fingerprint },
    rows,
  };
}
