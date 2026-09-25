/**
 * Shared assertions for the browser smoke suite.
 *
 * Keep these deterministic: they only depend on the smoke environment (no DB,
 * no chain contract ids, no secrets) and on strings that ship in messages/en.json.
 */

import { expect, type Page } from "@playwright/test";

/**
 * Patterns that must never appear in any served body of a smoke run. The smoke
 * build uses a strict env allowlist (scripts/lib/browser-smoke-env.mjs), so any
 * match here means a real secret or real contract id reached the served app:
 * that is always a bug in the harness, never something the test should ignore.
 */
export const SMOKE_SECRET_PATTERNS: ReadonlyArray<RegExp> = [
  // Stellar secret seeds (S…) and account keys (G…) are 56 chars of base32.
  /\bS[A-Z2-7]{55}\b/,
  // Soroban contract ids are C… StrKeys the app only ever holds via env vars.
  /\bC[A-Z2-7]{55}\b/,
  // PEM private keys.
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  // Server-only secret env var names leaking with an assignment.
  /\b(DEMO|STELLAR|ORACLE|POSTHOG)[A-Z0-9_]*(SECRET|SIGNING|PRIVATE|KEY|TOKEN)[A-Z0-9_]*\s*=/i,
  /DATABASE_URL\s*=\s*[a-z]+:\/\//i,
];

/** Asserts none of the poisoned patterns appear in `body`. */
export function expectNoSecrets(body: string): void {
  for (const pattern of SMOKE_SECRET_PATTERNS) {
    expect(pattern.test(body), `body must not match ${pattern}`).toBe(false);
  }
}

/**
 * Collects uncaught page errors (e.g. hydration failures, swallowed exceptions
 * in render) into the provided array. Browser tests assert this stayed empty.
 */
export function trackPageErrors(page: Page, errors: string[]): void {
  page.on("pageerror", (error) => errors.push(error.message));
}

/**
 * Waits for the app's `<main>` content region to be visible.
 */
export async function expectMainLandmark(page: Page): Promise<void> {
  await expect(page.locator("main")).toBeVisible();
}