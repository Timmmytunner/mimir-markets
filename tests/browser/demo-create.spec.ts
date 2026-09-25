/**
 * Demo create flow (the app's wallet-mock smoke: /vs/create?demo=1).
 *
 * This is the browser-level regression for the mock funding pipeline: filling
 * the full create form and submitting must run entirely client-side (no
 * contract call, no wallet, no secrets) and land on the "Challenge created"
 * success view with the simulated-transaction disclaimer. It is the proof that
 * launching a market stays deterministic and secret-free in the smoke build.
 */

import { expect, test } from "@playwright/test";

import { expectNoSecrets, trackPageErrors } from "./helpers";

const QUESTION = "Will BTC close above $100k by the end of next month?";
const CREATOR_SIDE = "BTC abandons $100k and trades below it all month";
const RIVAL_SIDE = "BTC finally breaks and holds above $100k for the month";
const SOURCE_URL = "https://www.coindesk.com/price/bitcoin/";

test.describe("demo create flow", () => {
  test("creates a challenge entirely in the mock (no contract or wallet)", async ({
    page,
  }) => {
    const errors: string[] = [];
    trackPageErrors(page, errors);

    await page.goto("/en/vs/create?demo=1", { waitUntil: "domcontentloaded" });

    // The demo banner proves this session is the mock one, not a live path.
    await expect(
      page.getByText(/demo mode: no contract or wallet calls/i),
    ).toBeVisible();

    await page.getByRole("textbox", { name: /what will happen/i }).fill(QUESTION);
    await page.getByRole("textbox", { name: "I bet", exact: true }).fill(CREATOR_SIDE);
    await page.getByRole("textbox", { name: "Rival bets", exact: true }).fill(RIVAL_SIDE);
    await page.getByRole("textbox", { name: "Verification source" }).fill(SOURCE_URL);

    // A future deadline via a preset (deterministic: no clock fiddling).
    await page.getByRole("button", { name: "3 days", exact: true }).click();

    // Custom markets need an explicit settlement rule — use the recommended one.
    await page
      .getByRole("button", { name: /advanced market terms/i })
      .click();
    await page
      .getByRole("button", { name: /use recommended rules/i })
      .click();

    // Submit the mock creation.
    await page.getByRole("button", { name: /create & fund/i }).click();

    // Funding overlay: simulated funding + confirmation only.
    await expect(
      page.getByText("Simulating funding and confirmation (demo only).", {
        exact: true,
      }),
    ).toBeVisible();

    // Success: headline + disclaimer + CTA, and the demo=1 query is gone so the
    // ticket URL is shareable.
    await expect(
      page.getByRole("heading", { name: /challenge created/i }).first(),
    ).toBeVisible();
    await expect(
      page.getByText(/these hashes are simulated; there is no on-chain transaction/i),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: /view challenge/i })).toBeVisible();
    expect(page.url()).not.toContain("demo=1");

    // Nothing leaked into the rendered document.
    expectNoSecrets(await page.evaluate(() => document.documentElement.outerHTML));
    expect(errors).toEqual([]);
  });
});