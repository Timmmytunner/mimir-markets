/**
 * Browser smoke flow orchestrator.
 *
 * Builds and serves the app in a deterministic, secret-free environment, runs
 * the Playwright suite in `tests/browser/`, and tears everything down — server
 * process, stashed `.env*` files, and report artifacts are never left behind.
 *
 * Why this exists (see issue #144 / browser smoke flow):
 *
 *   - Secrets can never reach a smoke run. The app is built and served with
 *     `buildSmokeEnv()` (`scripts/lib/browser-smoke-env.mjs`): an allowlist
 *     that drops every secret and every chain/contract id, plus `.env*` files
 *     are moved aside for the duration of the run. The app boots in its
 *     "chain not configured" state and the tests assert it fails closed.
 *   - Every smoke run produces the same result on a clean checkout: same env,
 *     same fixtures, same assertions. No live credentials, no live network
 *     dependence in the app code under test.
 *   - Failures are actionable: the run prints where to look (server log, Test
 *     Run summary) and what to rerun, and it never leaves a half-started server
 *     or a moved-env-file state behind.
 *
 * Exit codes: 0 = all tests passed; 1 = setup/teardown failure (with a printed
 * cause); otherwise the Playwright exit code (2 = suite failed, 211 = nothing
 * to run).
 *
 * Usage:
 *   node scripts/run-browser-smoke.mjs [--skip-build] [--port 3111] [-- <playwright args...>]
 *   Env: SMOKE_PORT, SMOKE_SKIP_BUILD, SMOKE_READY_TIMEOUT_MS
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildSmokeEnv,
  isLikelyCi,
  smokeEnvFileNames,
} from "./lib/browser-smoke-env.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_PORT = 3111;
const READY_TIMEOUT_MS = Number(process.env.SMOKE_READY_TIMEOUT_MS ?? 60_000);

function help() {
  console.log(`browser smoke flow

Runs the full smoke cycle against a locally built app with a deterministic,
secret-free environment, then tears the server and any stashed env files down.

Usage:
  node scripts/run-browser-smoke.mjs [options] [-- playwright-args...]

Options:
  --skip-build   Reuse an existing .next build instead of rebuilding.
  --port <n>     Port for the app server (default ${DEFAULT_PORT}, env SMOKE_PORT).
  --help         Show this help.

Playwright arguments after -- are forwarded to 'playwright test'
(e.g. '-- --filter boot' reruns only the boot spec).

Artifacts:
  playwright-report/  HTML report.
  test-results/       JSON test results + traces on failure.
  .next/browser-smoke/  server logs.
`);
}

function parseArgs(argv) {
  const opts = { skipBuild: false, port: Number(process.env.SMOKE_PORT ?? DEFAULT_PORT), playwrightArgs: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      opts.help = true;
    } else if (arg === "--skip-build") {
      opts.skipBuild = true;
    } else if (arg === "--port") {
      opts.port = Number(argv[++i]);
    } else if (arg === "--port=") {
      opts.port = Number(arg.slice("--port=".length));
    } else if (arg.startsWith("--port=")) {
      opts.port = Number(arg.slice("--port=".length));
    } else if (arg === "--") {
      opts.playwrightArgs = argv.slice(i + 1);
      break;
    } else {
      opts.playwrightArgs = argv.slice(i);
      break;
    }
  }
  if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) {
    throw new Error(`Invalid port "${opts.port}". Pass a number 1-65535 via --port or SMOKE_PORT.`);
  }
  if (process.env.SMOKE_SKIP_BUILD === "1") opts.skipBuild = true;
  return opts;
}

function addrFor(port) {
  return `http://127.0.0.1:${port}`;
}

async function portIsFree(port) {
  const { createServer } = await import("node:net");
  return new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

async function withPort(port, fn) {
  if (!(await portIsFree(port))) {
    throw new Error(
      `Port ${port} is already in use. Pick a free one with --port or SMOKE_PORT.`,
    );
  }
  return fn();
}

class TempStash {
  constructor() {
    this.dir = mkdtempSync(path.join(tmpdir(), "mimir-browser-smoke-"));
    this.files = new Map(); // original absolute path -> stashed absolute path
    this.restored = false;
  }

  async stashAll(envFileNames, baseDir) {
    let moved = 0;
    for (const name of envFileNames) {
      const from = path.join(baseDir, name);
      if (!existsSync(from)) continue;
      const to = path.join(this.dir, `${moved}-${name}`);
      await fs.rename(from, to);
      this.files.set(from, to);
      moved += 1;
    }
    return moved;
  }

  async restore() {
    if (this.restored) return;
    this.restored = true;
    for (const [from, to] of this.files) {
      const fromExists = existsSync(from);
      if (fromExists) {
        // Never clobber a file that appeared mid-run: restoring onto a live
        // file would silently overwrite the developer's current configuration.
        console.error(
          `[browser-smoke] Refusing to restore ${from}: a file already exists there (left as-is).`,
        );
        continue;
      }
      await fs.rename(to, from);
    }
    await fs.rm(this.dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function runBuild(env, { skipBuild }) {
  const nextDir = path.join(root, ".next");
  if (skipBuild) {
    if (!existsSync(path.join(nextDir, "BUILD_ID"))) {
      throw new Error(
        "--skip-build given but no .next build exists. Run without --skip-build (or npm run build first).",
      );
    }
    console.log("[browser-smoke] Reusing existing .next build.");
    return;
  }
  console.log("[browser-smoke] Building the app with the smoke environment…");
  const build = spawn(process.execPath, [path.join(root, "node_modules/next/dist/bin/next"), "build"], {
    cwd: root,
    env,
    stdio: ["ignore", "inherit", "inherit"],
    shell: false,
  });
  const code = await new Promise((resolve) => {
    build.once("exit", (c) => resolve(c ?? 1));
    build.once("error", (err) => { console.error(`[browser-smoke] Failed to start build: ${err.message}`); resolve(1); });
  });
  if (code !== 0) {
    throw new Error(
      `Build failed (exit ${code}). The smoke build uses a strict secret-free environment; if the app needs new NEXT_PUBLIC_* values to build, add them to SMOKE_NEXT_PUBLIC in scripts/lib/browser-smoke-env.mjs and its regression test.`,
    );
  }
}

async function waitForReady(port, serverLogPath, timeoutMs) {
  const startedAt = Date.now();
  let lastErr;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const res = await fetch(`${addrFor(port)}/en/`, {
        signal: AbortSignal.timeout(4000),
      });
      // Any HTTP response means the server is up; the tests assert status
      // codes themselves (e.g. /api/health must fail closed to 503).
      void res;
      return true;
    } catch (err) {
      lastErr = err;
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }
  throw new Error(
    `Server did not answer on ${addrFor(port)} within ${timeoutMs}ms` +
      (lastErr ? ` (last error: ${lastErr.message})` : "") +
      `. Tail of the server log:\n---\n${await readTail(serverLogPath, 40)}\n---`,
  );
}

async function readTail(filePath, lines) {
  try {
    const text = await fs.readFile(filePath, "utf8");
    return text.split("\n").slice(-lines).join("\n");
  } catch {
    return "(no server log yet)";
  }
}

function runPlaywright(env, args) {
  const bin = path.join(root, "node_modules/.bin/playwright");
  return new Promise((resolve) => {
    const child = spawn(bin, ["test", ...args], {
      cwd: root,
      env,
      stdio: "inherit",
      shell: false,
    });
    child.once("error", (err) => {
      console.error(`[browser-smoke] Could not start Playwright: ${err.message}`);
      console.error(
        "[browser-smoke] The smoke flow uses the system Chrome/Chromium (Playwright channel \"chrome\"); it does not download a browser. Install one or point Playwright at one via PLAYWRIGHT_BROWSERS_PATH/executablePath in playwright.config.ts.",
      );
      resolve(2);
    });
    child.once("exit", (c) => resolve(c ?? 1));
  });
}

async function launchServer(port, env, logPath) {
  const server = spawn(process.execPath, [path.join(root, "node_modules/next/dist/bin/next"), "start", "-p", String(port), "-H", "127.0.0.1"], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });
  const log = await fs.open(logPath, "w");
  server.stdout.pipe(log.createWriteStream());
  server.stderr.pipe(log.createWriteStream());
  let exited = false;
  server.once("exit", () => { exited = true; });
  return { server, log, isExited: () => exited };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    help();
    return 0;
  }

  const env = buildSmokeEnv();
  const envFiles = smokeEnvFileNames();
  const shownStash = envFiles.filter((name) => existsSync(path.join(root, name)));
  if (shownStash.length > 0) {
    console.log(
      `[browser-smoke] Moving ${shownStash.join(", ")} aside for the run (restored on exit).`,
    );
  }

  const stash = new TempStash();
  let serverHandle;
  let exitCode = 1;
  const teardown = async (code) => {
    if (serverHandle && !serverHandle.isExited()) {
      serverHandle.server.kill("SIGTERM");
      await new Promise((resolve) => {
        serverHandle.server.once("exit", resolve);
        setTimeout(resolve, 3000);
      }).catch(() => {});
      if (!serverHandle.isExited()) {
        console.error("[browser-smoke] Server did not stop after SIGTERM; forcing SIGKILL.");
        serverHandle.server.kill("SIGKILL");
      }
      try { await serverHandle.log.close(); } catch {}
    }
    await stash.restore();
    return code;
  };

  const signals = [];
  for (const sig of ["SIGINT", "SIGTERM"]) {
    const handler = () => { signals.push(sig); teardown(130).finally(() => process.exit(130)); };
    process.once(sig, handler);
  }

  try {
    const port = opts.port;
    await withPort(port, async () => {
      await stash.stashAll(envFiles, root);

      await runBuild(env, { skipBuild: opts.skipBuild });

      const logPath = path.join(root, ".next/browser-smoke/server.log");
      await fs.mkdir(path.dirname(logPath), { recursive: true });
      console.log(`[browser-smoke] Starting next start on ${addrFor(port)}…`);
      serverHandle = await launchServer(port, env, logPath);
      await waitForReady(port, logPath, READY_TIMEOUT_MS);
      console.log("[browser-smoke] Server ready. Running the Playwright suite…");

      env.SMOKE_BASE_URL = addrFor(port);
      env.PLAYWRIGHT_HTML_OPEN = "never";
      exitCode = await runPlaywright(env, opts.playwrightArgs);
    });
  } catch (err) {
    console.error(`[browser-smoke] ${err.message}`);
    exitCode = 1;
  } finally {
    exitCode = await teardown(exitCode);
  }

  if (exitCode === 0) {
    console.log("[browser-smoke] All browser smoke tests passed.");
  } else if (exitCode === 211) {
    console.error("[browser-smoke] No tests matched. Run with '-- --list' to see available specs.");
  } else {
    console.error(
      `[browser-smoke] Browser smoke suite failed (exit ${exitCode}). Open playwright-report/index.html or inspect test-results/ for traces.`,
    );
    if (!isLikelyCi()) {
      console.error("[browser-smoke] Rerun with: npm run smoke:browser");
    }
  }
  return exitCode;
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error(`[browser-smoke] Unhandled failure: ${err.stack ?? err.message}`);
  process.exit(1);
});