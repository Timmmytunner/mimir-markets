/**
 * Check that the contract toolchain matrix, the pinned release toolchain and the
 * declared MSRV agree. Offline and secret-free; reads four files and exits.
 *
 * Run: npm run check:toolchains
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { checkToolchains } from "./lib/contract-toolchains";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONTRACTS = path.join(ROOT, "contracts-soroban");

function read(file: string): string {
  return readFileSync(path.join(ROOT, file), "utf8");
}

const workspaceToml = read("contracts-soroban/Cargo.toml");
const members = [...(workspaceToml.match(/members\s*=\s*\[([^\]]*)\]/)?.[1] ?? "").matchAll(/"([^"]+)"/g)]
  .map((m) => m[1]);

const toolchainPath = path.join(ROOT, "rust-toolchain.toml");
const report = checkToolchains({
  toolchainToml: existsSync(toolchainPath) ? readFileSync(toolchainPath, "utf8") : null,
  workspaceToml,
  memberTomls: Object.fromEntries(
    members.map((member) => [member, readFileSync(path.join(CONTRACTS, member, "Cargo.toml"), "utf8")]),
  ),
  ciYaml: read(".github/workflows/ci.yml"),
});

console.log(`contract toolchains: msrv ${report.msrv ?? "?"} · release ${report.release ?? "?"} · ` +
  `matrix ${Object.entries(report.matrix).map(([k, v]) => `${k}=${v}`).join(", ") || "none"}`);

if (report.problems.length > 0) {
  for (const problem of report.problems) console.error(`✗ ${problem}`);
  console.error("\nSee docs/CONTRACT_TOOLCHAINS.md for how the three files fit together.");
  process.exit(1);
}
console.log("✓ toolchain pins, MSRV and CI matrix agree");
