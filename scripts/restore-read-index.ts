/**
 * Restore a verified read-index cache backup archive.
 *
 *   npm run restore:read-index -- backups/read-index.json
 *   npm run restore:read-index -- backups/read-index.json --dry-run
 *
 * Requires DATABASE_URL. The archive must verify (checksum + privacy) before a
 * single write starts; all writes run in one transaction so a failure rolls
 * back to the pre-restore cache; and after commit the tables are re-read and
 * fingerprinted against the archive's checksum.
 *
 * Exit codes: 0 restored & verified · 1 unverified archive or restore drift ·
 * 2 usage error.
 */
import { readFileSync } from "node:fs";

import { formatCacheBackupReport } from "../lib/ops/cache-backup";
import { restoreReadIndexFromBackup } from "../lib/server/read-index-backup";

function parseArgs(argv: string[]): { path: string; dryRun: boolean } {
  const args = argv.filter((arg) => arg !== "--dry-run");
  const dryRun = argv.includes("--dry-run");
  const [path] = args;
  if (!path) {
    throw new Error("usage: npm run restore:read-index -- <archive.json> [--dry-run]");
  }
  return { path, dryRun };
}

async function main(): Promise<void> {
  const { path, dryRun } = parseArgs(process.argv.slice(2));
  const archiveText = readFileSync(path, "utf8");

  const result = await restoreReadIndexFromBackup(archiveText, { dryRun });

  const action = dryRun ? "dry-run (no writes)" : "restored";
  console.log(
    `[restore] ${action} ${result.restored.length} tables: ` +
      result.restored.map((t) => `${t.table}=${t.rows}`).join(" "),
  );

  const verification = formatCacheBackupReport(result.verify);
  console.log(`[restore] post-restore verification — ${verification}`);

  if (result.applied && !result.verify.ok) {
    console.error(
      "[restore] the cache does not match the archive. Re-apply the archive or " +
        "re-warm from chain (`npm run warm:vs-index` / `npm run sync`).",
    );
    process.exit(1);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error("[restore] failed:", message);
  process.exit(message.startsWith("usage:") ? 2 : 1);
});