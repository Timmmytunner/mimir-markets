/**
 * Health fail-closed smoke.
 *
 * The smoke build runs with no DATABASE_URL and no chain configuration. The
 * health endpoint must answer loudly — 503 "critical" with a db.unconfigured
 * alarm and no-store caching — and must never expose secrets.
 */

import { expect, test } from "@playwright/test";

import { expectNoSecrets } from "./helpers";

test.describe("health", () => {
  test("reports critical db.unconfigured without a database", async ({ page }) => {
    const response = await page.request.get("/api/health");
    expect(response.status()).toBe(503);
    expect(response.headers()["content-type"] ?? "").toContain("application/json");
    // No-store: health must never be cached, anywhere.
    expect(response.headers()["cache-control"] ?? "").toContain("no-store");

    const body = await response.json();
    expect(body.status).toBe("critical");
    const alarms: Array<{ id: string; severity: string }> = body.alarms ?? [];
    expect(alarms.some((alarm) => alarm.id === "db.unconfigured")).toBe(true);
    expect(alarms.some((alarm) => alarm.severity === "critical")).toBe(true);

    expectNoSecrets(JSON.stringify(body));
  });

  test("fails closed on the public JSON endpoints too", async ({ page }) => {
    // Arena feed without a DB must degrade to an empty list, not a crash or a
    // leaked row.
    const feed = await page.request.get("/api/vs");
    expect(feed.status()).toBe(200);
    expect(feed.headers()["content-type"] ?? "").toContain("application/json");
    const feedBody = await feed.json();
    expect(Array.isArray(feedBody.items)).toBe(true);
    expect(feedBody.items.length).toBe(0);
    expectNoSecrets(JSON.stringify(feedBody));

    // Analytics with no key/posthog is a silent no-op, never a 500.
    const event = await page.request.post("/api/analytics/event", {
      data: { event: "page_view" },
    });
    expect(event.status()).toBe(204);
    expectNoSecrets(await event.text());
  });
});