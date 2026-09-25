/**
 * Dump the Neon read-index cache to a self-verified backup archive.
 *
 *   npm run backup:read-index                 # archive → stdout
 *   npm run backup:read-index -- --out backups/read-index.json
 *
 * Requires DATABASE_URL. Needs NO Stellar seeds, NO RPC, NO LLM keys — the dump
 * reads the cache's projection tables and nothing else, and it verifies its own
 * checksum + privacy invariants before writing a byte.
 *
 * Exit 0 only when the produced archive verifies.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { CONTRACT_ADDRESS } from "../lib/contract";
import {
  backUpReadIndex,
  buildBackupSource,
} from "../lib/server/read-index-backup";
import { formatCacheBackupReport } from "../lib/ops/cache-backup";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_JSON = JSON.parse(
  readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"),
) as { version?: string };

function parseOutPath(args: string[]): string | null {
  const index = args.indexOf("--out");
  if (index === -1) return null;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error("--out requires a path");
  }
  return value;
}

async function main(): Promise<void> {
  const outPath = parseOutPath(process.argv.slice(2));

  const source = buildBackupSource({
    contractAddress: String(CONTRACT_ADDRESS ?? "").trim() || undefined,
    network: "stellar:testnet",
    appVersion: PACKAGE_JSON.version,
  });

  const { backup, report } = await backUpReadIndex({ source });

  const counts = Object.entries(backup.tables)
    .map(([name, rows]) => `${name}:${rows.length}`)
    .join(" ");
  console.log(`[backup] read-index snapshot ${counts}`);

  if (outPath) {
    writeFileSync(outPath, `${JSON.stringify(backup, null, 2)}\n`, "utf8");
    console.log(`[backup] wrote ${outPath}`);
  } else {
    process.stdout.write(`${JSON.stringify(backup, null, 2)}\n`);
  }

  console.log(formatCacheBackupReport(report));
  if (!report.ok) process.exit(1);
}

main().catch((error) => {
  console.error(
    "[backup] failed:",
    error instanceof Error ? error.message : error,
  );
  process.exit(1);
});