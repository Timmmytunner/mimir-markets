/**
 * Wallet-gated money paths on a cold, unconfigured build.
 *
 * Launching a market signs and funds a real transaction — that power must be
 * gated behind a connected, signing wallet. On a smoke build with none, the
 * create page must offer only a connect control, the dashboard must say
 * "Connect your wallet", and the wallet picker (the "mock" wallet surface the
 * app ships for testing) must be reachable and deterministic.
 */

import { expect, test } from "@playwright/test";

import { expectMainLandmark, trackPageErrors } from "./helpers";

test.describe("wallet-gated money paths", () => {
  test("/en/vs/create offers only the connect gate before a wallet", async ({
    page,
  }) => {
    const errors: string[] = [];
    trackPageErrors(page, errors);

    await page.goto("/en/vs/create", { waitUntil: "domcontentloaded" });
    await expectMainLandmark(page);

    // No "Create & Fund" without a wallet: the money path is unreachable.
    await expect(
      page.getByRole("button", { name: /create & fund/i }),
    ).toHaveCount(0);

    // The connect control is the only way forward.
    await expect(
      page.getByRole("button", { name: /connect wallet/i }),
    ).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("/en/dashboard explains the connect gate for its money overview", async ({
    page,
  }) => {
    await page.goto("/en/dashboard", { waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("heading", { name: /connect your wallet/i }),
    ).toBeVisible();
  });

  test("the wallet picker shell is reachable and deterministic", async ({
    page,
  }) => {
    const errors: string[] = [];
    trackPageErrors(page, errors);

    await page.goto("/en/explorer", { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Connect", exact: true }).click();

    const dialog = page.getByRole("dialog", { name: "Connect wallet" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("Stellar · testnet");
    // The roster shell (installed wallets + a fallback list) is deterministic
    // on this build: some rows show, and the "without one?" fallback exists.
    await expect(dialog.getByText("Don't have one? (")).toBeVisible();

    // Dismissing must leave the page intact.
    await dialog.getByRole("button", { name: "Close" }).click();
    await expect(dialog).toBeHidden();
    expect(errors).toEqual([]);
  });
});