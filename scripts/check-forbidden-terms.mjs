/**
 * Guardrail: Mimir is a Stellar Testnet application. Fail the build if any
 * term below shows up in a tracked file — a match here is a bug, not a
 * leftover comment. lib/xmtp/identity.ts is explicitly allowlisted: it holds
 * a hidden, internal-only signing key that XMTP's own protocol requires,
 * unrelated to Mimir's own contracts or trading paths.
 *
 * Run: npm run check:terms
 */
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

const FORBIDDEN = [
  ["botchain", /botchain/i],
  ["BOT Chain", /BOT[\s-]?Chain/i],
  ["bohr.life", /bohr\.life/i],
  ["chain 968", /\bchain[\s_-]?968\b|\b968\b(?=\s*\))/i],
  ["USDT", /\bUSDT\b/],
  ["USDT_ADDRESS", /USDT_ADDRESS/],
  ["amount_bot", /amount_bot/],
  ["X-Payment-Tx", /X-Payment-Tx/i],
  ["X-Payment-From", /X-Payment-From/i],
  ["BOT currency", /\bBOT\b(?!\w)/],
  ["Base Sepolia", /\bBase[\s-]?Sepolia\b/i],
  ["base-sepolia (slug)", /base-sepolia/i],
  ["Base mainnet chain id", /\b8453\b/],
  ["Base Sepolia chain id", /\b84532\b/],
  ["eip155 CAIP-2", /eip155:/i],
  ["wagmi", /\bwagmi\b/i],
  ["viem", /\bviem\b/i],
  ["@base-org", /@base-org/i],
  ["privy", /\bprivy\b/i],
  ["ethers.js", /\bethers\b/i],
  ["@x402/evm", /@x402\/evm/i],
  ["coinbase paymaster", /\bpaymaster\b/i],
  ["MetaMask", /\bMetaMask\b/i],
  ["WalletConnect", /\bWalletConnect\b/i],
  ["Stellar Secret Seed", /S[A-Z2-7]{55}/],
  ["GitHub Token", /gh[ps]_[a-zA-Z0-9]{36}/],
  ["Stripe/Generic Secret (sk_live_)", /sk_live_[a-zA-Z0-9]{20,}/],
  ["Anthropic API Key", /sk-ant-[a-zA-Z0-9_-]{20,}/],
  ["Groq API Key", /gsk_[a-zA-Z0-9_-]{20,}/],
  ["Google API Key (AIza)", /AIza[a-zA-Z0-9_-]{35}/],
  ["PostHog API Key", /phc_[a-zA-Z0-9_-]{43}/]
];

const SKIP_FILES = new Set([
  "scripts/check-forbidden-terms.mjs",
  "lib/xmtp/identity.ts",
  "tests/node/x402-fixtures.ts",
  "tests/node/security-headers.test.ts"
]);

const files = execSync("git ls-files", { encoding: "utf8" })
  .split("\n")
  .filter(Boolean)
  .filter((f) => /\.(ts|tsx|sol|rs|md|json|toml|js|mjs|css|ya?ml)$/.test(f) || f === ".env.example")
  .filter((f) => !SKIP_FILES.has(f) && !f.startsWith("package-lock.json"));

const hits = [];
for (const file of files) {
  let lines;
  try {
    lines = readFileSync(file, "utf8").split(/\r?\n/);
  } catch {
    continue;
  }
  lines.forEach((line, i) => {
    for (const [label, pattern] of FORBIDDEN) {
      if (pattern.test(line)) hits.push({ file, line: i + 1, label, text: line.trim().slice(0, 120) });
    }
  });
}

if (hits.length > 0) {
  console.error(`✗ ${hits.length} forbidden term(s) found:\n`);
  for (const h of hits) console.error(`  ${h.file}:${h.line}  [${h.label}]  ${h.text}`);
  process.exit(1);
}

console.log(`✓ no forbidden terms in ${files.length} tracked files`);
