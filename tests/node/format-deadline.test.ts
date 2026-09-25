import assert from "node:assert/strict";
import test from "node:test";

import { formatDeadline, getUserTimeZone } from "../../lib/constants";

// Fixed unix second: 2023-11-14T22:13:20.000Z
const TS = 1_700_000_000;

test("getUserTimeZone returns a non-empty IANA-like string", () => {
  const tz = getUserTimeZone();
  assert.equal(typeof tz, "string");
  assert.ok(tz.length > 0);
});

test("formatDeadline returns empty for invalid or zero timestamps", () => {
  assert.equal(formatDeadline(0, "en"), "");
  assert.equal(formatDeadline(-1, "en"), "");
  assert.equal(formatDeadline(Number.NaN, "en"), "");
});

test("formatDeadline renders the wall clock in America/New_York", () => {
  const out = formatDeadline(TS, "en", "America/New_York");
  // 2023-11-14 is EST (UTC-5) → 17:13
  assert.match(out, /Nov/i);
  assert.match(out, /14/);
  assert.match(out, /2023/);
  assert.match(out, /5:13|17:13/);
  assert.match(out, /EST|EDT|GMT-5|UTC-5/i);
});

test("formatDeadline renders the wall clock in Asia/Tokyo", () => {
  const out = formatDeadline(TS, "en", "Asia/Tokyo");
  // UTC 22:13 → JST 07:13 next day (Nov 15)
  assert.match(out, /15/);
  assert.match(out, /7:13|07:13/);
  assert.match(out, /JST|GMT\+9|UTC\+9/i);
});

test("formatDeadline changes when the timezone changes (regression)", () => {
  const ny = formatDeadline(TS, "en", "America/New_York");
  const tokyo = formatDeadline(TS, "en", "Asia/Tokyo");
  assert.notEqual(ny, tokyo);
});

test("formatDeadline falls back safely on an invalid timezone id", () => {
  const out = formatDeadline(TS, "en", "Not/A_Real_Zone");
  assert.equal(typeof out, "string");
  assert.ok(out.length > 0);
});

test("formatDeadline supports Spanish locale labels", () => {
  const out = formatDeadline(TS, "es", "UTC");
  assert.match(out, /2023/);
  assert.match(out, /22:13|10:13/);
  assert.match(out, /UTC|GMT/i);
});
