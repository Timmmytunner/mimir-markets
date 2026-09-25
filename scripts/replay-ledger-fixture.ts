import { resolve } from "node:path";
import { loadLedgerFixture, replayLedgerFixture } from "../lib/ops/ledger-fixture";
const fixturePath = resolve(process.argv[2] ?? "fixtures/ledger/funded-market-v1.json");

async function main() {
  try {
    const artifact = replayLedgerFixture(await loadLedgerFixture(fixturePath));
    process.stdout.write(`${JSON.stringify(artifact, null, 2)}\n`);
  } catch (error) {
    // Never dump fixture records or environment values into CI/operator logs.
    console.error(`[ledger-replay] ${error instanceof Error ? error.message : "unknown failure"}`);
    process.exitCode = 1;
  }
}

void main();
