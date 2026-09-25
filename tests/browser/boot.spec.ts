/**
 * Boot smoke: the app serves, the locale routing works, the shell renders, and
 * every HTML response carries the security headers the app promises
 * (mirroring tests/node/security-headers.test.ts against the live server).
 */

import { expect, test } from "@playwright/test";

import { expectMainLandmark, expectNoSecrets, trackPageErrors } from "./helpers";

const SECURITY_HEADER_CHECKS: ReadonlyArray<readonly [string, RegExp]> = [
  ["content-security-policy", /frame-ancestors 'none'/],
  ["content-security-policy", /upgrade-insecure-requests/],
  ["x-frame-options", /^DENY$/i],
  ["x-content-type-options", /^nosniff$/i],
  ["strict-transport-security", /^max-age=\d+/i],
  ["referrer-policy", /^strict-origin-when-cross-origin$/i],
  ["permissions-policy", /geolocation=\(\)/],
  ["permissions-policy", /payment=\(self\)/],
];

test.describe("boot", () => {
  test("unprefixed routes resolve to the en locale shell", async ({ page }) => {
    const errors: string[] = [];
    trackPageErrors(page, errors);

    await page.goto("/", { waitUntil: "domcontentloaded" });
    expect(page.url()).toContain("/en");

    // The hero headline: "DON'T ARGUE. SETTLE. WITH Mimir." split across
    // kinetic spans, so match the stable first line only.
    await expect(
      page.getByRole("heading", { name: /don't argue/i }).first(),
    ).toBeVisible();
    await expectMainLandmark(page);
    await expect(page.getByRole("link", { name: "Skip", exact: true })).toBeAttached();
    expect(errors).toEqual([]);
  });

  test("every HTML response carries the promised security headers", async ({
    page,
  }) => {
    const response = await page.request.get("/en/");
    expect(response.status()).toBe(200);
    for (const [header, pattern] of SECURITY_HEADER_CHECKS) {
      const value = response.headers()[header.toLowerCase()];
      expect(
        value,
        `expected response to have header "${header}" (got ${value ?? "nothing"})`,
      ).toBeDefined();
      expect(value).toMatch(pattern);
    }
    expectNoSecrets(await response.text());
  });

  test("unknown routes return the app's 404, never a stack trace", async ({
    page,
  }) => {
    const response = await page.request.get("/en/this-route-does-not-exist-zzz");
    expect(response.status()).toBe(404);
    const body = await response.text();
    expect(body).not.toContain("Unhandled Runtime Error");
    expectNoSecrets(body);
  });
});