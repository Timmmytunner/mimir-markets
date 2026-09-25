import assert from "node:assert/strict";
import test from "node:test";
import {
  assetsForRedemption,
  basketExposure,
  DEFAULT_BASKET_POLICY,
  highWaterMarkFee,
  previewBasketExposureBeforeCreate,
  sharesForDeposit,
  simulateVirtualBasket,
  validateBasket,
} from "../../lib/baskets";

const weights = [
  { agentId: "a", weightBps: 4_000, category: "crypto", mode: "pool" },
  { agentId: "b", weightBps: 3_000, category: "sports", mode: "duel" },
  { agentId: "c", weightBps: 3_000, category: "sports", mode: "pool", stale: true },
];
const policy = { maxSingleAgentBps: 5_000, maxCategoryBps: 6_000, staleSignalAction: "skip" as const, failedCopyAction: "keep_idle" as const };

test("virtual basket validates weights and exposes category/mode concentration", () => {
  assert.deepEqual(validateBasket(weights, policy), []);
  assert.deepEqual(basketExposure(weights), { categories: { crypto: 4_000, sports: 6_000 }, modes: { pool: 7_000, duel: 3_000 } });
});

test("stale agents stay idle and NAV/drawdown are deterministic atomic values", () => {
  const snapshots = simulateVirtualBasket(weights, [{ timestamp: 1, returnsBps: { a: 1_000, b: -500, c: 9_999 } }, { timestamp: 2, returnsBps: { a: -2_000, b: -1_000, c: 9_999 } }]);
  assert.equal(snapshots[0]!.navAtomic, 1_025_000_000n);
  assert.ok(snapshots[1]!.drawdownBps > 0);
});

test("high-water mark prevents repeated performance fees", () => {
  assert.deepEqual(highWaterMarkFee(1_100_000n, 1_000_000n, 1_000n), { feeAtomic: 10_000n, nextHighWaterMarkAtomic: 1_100_000n });
  assert.equal(highWaterMarkFee(1_050_000n, 1_100_000n, 1_000n).feeAtomic, 0n);
});

test("share conversions conserve atomic rounding and never overpay", () => {
  for (let assets = 1n; assets < 1_000n; assets += 7n) {
    const shares = sharesForDeposit(assets, 1_000_003n, 999_983n);
    if (shares === 0n) continue;
    assert.ok(assetsForRedemption(shares, 1_000_003n, 999_983n) <= assets);
  }
});

test("exposure preview: empty basket stays empty with no policy errors", () => {
  const preview = previewBasketExposureBeforeCreate([]);
  assert.equal(preview.status, "empty");
  assert.equal(preview.totalBps, 0);
  assert.deepEqual(preview.errors, []);
  assert.deepEqual(preview.categoryBars, []);
});

test("exposure preview: incomplete allocation still shows live bars", () => {
  const preview = previewBasketExposureBeforeCreate([
    { agentId: "a", weightBps: 2_500, category: "council", mode: "pool" },
    { agentId: "b", weightBps: 2_500, category: "byoa", mode: "pool" },
  ]);
  assert.equal(preview.status, "incomplete");
  assert.equal(preview.totalBps, 5_000);
  assert.ok(preview.errors.includes("weights_must_total_10000_bps"));
  assert.equal(preview.categoryBars.length, 2);
  assert.equal(preview.agentBars.every((bar) => !bar.overLimit), true);
});

test("exposure preview: category over default 60% cap is invalid at 100%", () => {
  const preview = previewBasketExposureBeforeCreate([
    { agentId: "a", weightBps: 4_000, category: "council", mode: "pool" },
    { agentId: "b", weightBps: 3_500, category: "council", mode: "pool" },
    { agentId: "c", weightBps: 2_500, category: "byoa", mode: "pool" },
  ], DEFAULT_BASKET_POLICY);
  assert.equal(preview.status, "invalid");
  assert.ok(preview.errors.includes("category_exposure"));
  const council = preview.categoryBars.find((bar) => bar.key === "council");
  assert.ok(council);
  assert.equal(council!.bps, 7_500);
  assert.equal(council!.overLimit, true);
});

test("exposure preview: single agent over 40% flags agent bar at the boundary", () => {
  // Boundary: 40% exact is allowed; 41% is not.
  const atCap = previewBasketExposureBeforeCreate([
    { agentId: "a", weightBps: 4_000, category: "council", mode: "pool" },
    { agentId: "b", weightBps: 3_000, category: "byoa", mode: "pool" },
    { agentId: "c", weightBps: 3_000, category: "philosopher", mode: "pool" },
  ], DEFAULT_BASKET_POLICY);
  assert.equal(atCap.status, "ready");
  assert.deepEqual(atCap.errors, []);

  const over = previewBasketExposureBeforeCreate([
    { agentId: "a", weightBps: 4_100, category: "council", mode: "pool" },
    { agentId: "b", weightBps: 3_000, category: "byoa", mode: "pool" },
    { agentId: "c", weightBps: 2_900, category: "philosopher", mode: "pool" },
  ], DEFAULT_BASKET_POLICY);
  assert.equal(over.status, "invalid");
  assert.ok(over.errors.includes("single_agent_exposure"));
  const agentA = over.agentBars.find((bar) => bar.key === "a");
  assert.equal(agentA?.overLimit, true);
});

test("exposure preview: ready mix matches basketExposure categories and modes", () => {
  const ready = [
    { agentId: "a", weightBps: 3_000, category: "council", mode: "pool" },
    { agentId: "b", weightBps: 3_000, category: "byoa", mode: "pool" },
    { agentId: "c", weightBps: 4_000, category: "philosopher", mode: "pool" },
  ];
  const preview = previewBasketExposureBeforeCreate(ready, DEFAULT_BASKET_POLICY);
  assert.equal(preview.status, "ready");
  assert.deepEqual(preview.categories, basketExposure(ready).categories);
  assert.deepEqual(preview.modes, basketExposure(ready).modes);
  assert.equal(preview.policy.maxCategoryBps, DEFAULT_BASKET_POLICY.maxCategoryBps);
});

test("regression: zero-weight rows are ignored in the create preview", () => {
  const preview = previewBasketExposureBeforeCreate([
    { agentId: "a", weightBps: 4_000, category: "council", mode: "pool" },
    { agentId: "b", weightBps: 0, category: "council", mode: "pool" },
    { agentId: "c", weightBps: 3_000, category: "byoa", mode: "pool" },
    { agentId: "d", weightBps: 3_000, category: "philosopher", mode: "pool" },
  ]);
  assert.equal(preview.status, "ready");
  assert.equal(preview.agentBars.some((bar) => bar.key === "b"), false);
  assert.equal(preview.categories.council, 4_000);
});
