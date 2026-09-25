import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { loadLedgerFixture, parseLedgerFixture, replayLedgerFixture } from "../../lib/ops/ledger-fixture";
const fixturePath = resolve("fixtures/ledger/funded-market-v1.json");
test("saved funded ledger replays to the reviewed read-index artifact", async () => {
  const artifact = replayLedgerFixture(await loadLedgerFixture(fixturePath));
  assert.equal(artifact.reconciliation.claimCount, 1);
  assert.equal(artifact.reconciliation.orphanEvents, 0);
  assert.equal(artifact.rows[0].state, "resolved");
  assert.equal(artifact.rows[0].totalChallengerStakeUnits, "25000000");
  assert.equal(artifact.rows[0].creator, "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF");
});
test("replay is deterministic across fixture loads", async () => {
  assert.deepEqual(replayLedgerFixture(await loadLedgerFixture(fixturePath)), replayLedgerFixture(await loadLedgerFixture(fixturePath)));
});
test("tampered money data fails the reviewed fingerprint", async () => {
  const fixture = await loadLedgerFixture(fixturePath); fixture.events[1].stakeUnits = 99n;
  assert.throws(() => replayLedgerFixture(fixture), /fingerprint differs from the reviewed fixture/);
});
test("incomplete capture fails closed on orphan events", async () => {
  const fixture = await loadLedgerFixture(fixturePath); fixture.events = fixture.events.slice(1);
  assert.throws(() => replayLedgerFixture(fixture), /1 orphan event/);
});
test("conflicting events at one ledger position are rejected", () => {
  const base = { version: 1, name: "conflict", network: "stellar:testnet", contractId: "contract", deployLedger: 10, capturedThroughLedger: 10, reorgedOut: [], expectedFingerprint: "reviewed" };
  assert.throws(() => parseLedgerFixture({ ...base, events: [
    { name: "ClaimCreated", claimId: 1, creator: "GA", ledger: 10, eventIndex: 0 },
    { name: "ClaimCreated", claimId: 2, creator: "GB", ledger: 10, eventIndex: 0 },
  ] }), /conflicting events share ledger position 10:0/);
});
test("atomic amounts must be lossless decimal strings", () => {
  assert.throws(() => parseLedgerFixture({
    version: 1, name: "unsafe-money", network: "stellar:testnet", contractId: "contract",
    deployLedger: 10, capturedThroughLedger: 11, reorgedOut: [], expectedFingerprint: "reviewed",
    events: [{ name: "ClaimChallenged", claimId: 1, challenger: "GA", stakeAtomic: 2.5, ledger: 11, eventIndex: 0 }],
  }), /stakeAtomic: must be an unsigned base-10 string/);
});
