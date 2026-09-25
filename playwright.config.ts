import { defineConfig } from "@playwright/test";

/**
 * Browser smoke suite configuration.
 *
 * Run via `npm run smoke:browser` (see scripts/run-browser-smoke.mjs): that
 * orchestrator builds and serves the app with a strict secret-free environment
 * on a dedicated port, sets SMOKE_BASE_URL, runs `playwright test`, and tears
 * the server down afterwards. This config deliberately defines no `webServer`:
 * the orchestrator owns the whole build/serve lifecycle.
 *
 * The suite uses the system Chrome/Chromium (Playwright channel "chrome") and
 * downloads no browser. To point it at a specific binary, set SMOKE_CHROME_PATH;
 * otherwise a stock Chrome or Chromium on PATH is used.
 */
const baseURL = process.env.SMOKE_BASE_URL ?? "http://127.0.0.1:3111";
const workers = Number(process.env.SMOKE_WORKERS ?? 2);
const channel = process.env.SMOKE_CHROME_PATH ? undefined : "chrome";
const launchOptions = process.env.SMOKE_CHROME_PATH
  ? { executablePath: process.env.SMOKE_CHROME_PATH }
  : {};

export default defineConfig({
  testDir: "./tests/browser",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 12_000 },
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: "playwright-report" }],
  ],
  use: {
    baseURL,
    channel,
    launchOptions,
    headless: true,
    viewport: { width: 1440, height: 900 },
    colorScheme: "dark",
    locale: "en-US",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  outputDir: "test-results",
});