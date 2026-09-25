/**
 * Verify a read-index cache backup archive — fully offline.
 *
 *   npm run verify:cache-backup -- backups/read-index.json
 *   cat backups/read-index.json | npm run verify:cache-backup -- -
 *
 * No DATABASE_URL, no network, no secrets: this runs on a clean checkout, in CI,
 * or in a cold restore container, and the verdict is byte-reproducible.
 *
 * Exit 0 only for a structurally valid, checksum-matched, privacy-clean archive.
 */
import { readFileSync } from "node:fs";

import {
  formatCacheBackupReport,
  verifyCacheBackup,
} from "../lib/ops/cache-backup";

async function main(): Promise<void> {
  const [maybePath] = process.argv.slice(2);
  const text =
    maybePath && maybePath !== "-"
      ? readFileSync(maybePath, "utf8")
      : await new Promise<string>((resolve, reject) => {
          let buffer = "";
          process.stdin.setEncoding("utf8");
          process.stdin.on("data", (chunk: string) => { buffer += chunk; });
          process.stdin.on("end", () => resolve(buffer));
          process.stdin.on("error", reject);
        });

  const report = verifyCacheBackup(text);
  console.log(formatCacheBackupReport(report));
  if (!report.ok) process.exit(1);
}

main().catch((error) => {
  console.error(
    "[verify] failed:",
    error instanceof Error ? error.message : error,
  );
  process.exit(1);
});