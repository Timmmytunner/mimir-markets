import assert from "node:assert/strict";
import test from "node:test";

import {
  CREATE_STAKE_PRESET_GRID_CLASS,
  CREATE_STAKE_CUSTOM_CELL_CLASS,
  CREATE_TOUCH_TARGET_MIN_PX,
  createPageBottomPaddingPx,
  createViewportBucket,
  shouldShowMobileCreateCta,
  stakePresetColumnsForViewport,
} from "../../lib/createFormResponsive";

test("positive: mobile bucket under sm breakpoint", () => {
  assert.equal(createViewportBucket(375), "mobile");
  assert.equal(createViewportBucket(639), "mobile");
  assert.equal(stakePresetColumnsForViewport(375), 2);
  assert.equal(shouldShowMobileCreateCta(375), true);
  assert.equal(createPageBottomPaddingPx(375), 112);
});

test("positive: tablet bucket between sm and lg", () => {
  assert.equal(createViewportBucket(640), "tablet");
  assert.equal(createViewportBucket(1023), "tablet");
  assert.equal(stakePresetColumnsForViewport(768), 3);
  assert.equal(shouldShowMobileCreateCta(768), true);
});

test("positive: desktop bucket at lg and above", () => {
  assert.equal(createViewportBucket(1024), "desktop");
  assert.equal(createViewportBucket(1440), "desktop");
  assert.equal(stakePresetColumnsForViewport(1280), 5);
  assert.equal(shouldShowMobileCreateCta(1280), false);
  assert.equal(createPageBottomPaddingPx(1280), 48);
});

test("negative: invalid widths fall back to mobile-safe layout", () => {
  assert.equal(createViewportBucket(Number.NaN), "mobile");
  assert.equal(createViewportBucket(-10), "mobile");
  assert.equal(shouldShowMobileCreateCta(-1), true);
});

test("boundary: exact Tailwind sm and lg cutovers", () => {
  assert.equal(createViewportBucket(639.9), "mobile");
  assert.equal(createViewportBucket(640), "tablet");
  assert.equal(createViewportBucket(1023.9), "tablet");
  assert.equal(createViewportBucket(1024), "desktop");
});

test("regression: stake grid classes stay mobile-first (not fixed cols-5)", () => {
  assert.match(CREATE_STAKE_PRESET_GRID_CLASS, /grid-cols-2/);
  assert.match(CREATE_STAKE_PRESET_GRID_CLASS, /md:grid-cols-5/);
  assert.doesNotMatch(CREATE_STAKE_PRESET_GRID_CLASS, /^grid grid-cols-5/);
  assert.match(CREATE_STAKE_CUSTOM_CELL_CLASS, /col-span-2/);
  assert.ok(CREATE_TOUCH_TARGET_MIN_PX >= 44);
});
