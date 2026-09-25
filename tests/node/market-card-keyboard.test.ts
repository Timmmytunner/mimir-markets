import assert from "node:assert/strict";
import test from "node:test";

import {
  buildMarketCardNavItems,
  decideMarketCardKey,
  inferGridColumns,
  isMarketCardNavigable,
  isMarketCardNavKey,
  marketCardTabIndex,
  normalizeMarketCardState,
  resolveNextMarketCardIndex,
  shouldActivateMarketCard,
} from "../../lib/market-card-keyboard";

function cards(
  specs: Array<string | { id: string; state?: string; disabled?: boolean; hidden?: boolean }>,
) {
  return buildMarketCardNavItems(
    specs.map((s) => (typeof s === "string" ? { id: s, state: "open" } : s)),
  );
}

// ── Positive ────────────────────────────────────────────────────────────────

test("arrow right moves focus to the next navigable market card", () => {
  const items = cards(["1", "2", "3"]);
  assert.equal(
    resolveNextMarketCardIndex({
      items,
      currentIndex: 0,
      key: "ArrowRight",
      columns: 3,
    }),
    1,
  );
});

test("arrow left moves focus to the previous navigable market card", () => {
  const items = cards(["1", "2", "3"]);
  assert.equal(
    resolveNextMarketCardIndex({
      items,
      currentIndex: 2,
      key: "ArrowLeft",
      columns: 3,
    }),
    1,
  );
});

test("arrow down moves by column count in a 3-column grid", () => {
  const items = cards(["1", "2", "3", "4", "5", "6"]);
  assert.equal(
    resolveNextMarketCardIndex({
      items,
      currentIndex: 1,
      key: "ArrowDown",
      columns: 3,
    }),
    4,
  );
});

test("arrow up moves by column count in a 3-column grid", () => {
  const items = cards(["1", "2", "3", "4", "5", "6"]);
  assert.equal(
    resolveNextMarketCardIndex({
      items,
      currentIndex: 4,
      key: "ArrowUp",
      columns: 3,
    }),
    1,
  );
});

test("Home and End jump to first and last navigable cards", () => {
  const items = cards(["1", "2", "3"]);
  assert.equal(
    resolveNextMarketCardIndex({
      items,
      currentIndex: 1,
      key: "Home",
      columns: 3,
    }),
    0,
  );
  assert.equal(
    resolveNextMarketCardIndex({
      items,
      currentIndex: 1,
      key: "End",
      columns: 3,
    }),
    2,
  );
});

test("Enter and Space activate the focused market card", () => {
  const items = cards(["1", "2"]);
  const enter = decideMarketCardKey("Enter", {
    items,
    currentIndex: 1,
    columns: 2,
  });
  assert.equal(enter.type, "activate");
  assert.equal(enter.nextIndex, 1);

  const space = decideMarketCardKey(" ", {
    items,
    currentIndex: 0,
    columns: 2,
  });
  assert.equal(space.type, "activate");
  assert.equal(space.preventDefault, true);
});

test("roving tabindex keeps only the active navigable card in tab order", () => {
  assert.equal(marketCardTabIndex(0, 0, true), 0);
  assert.equal(marketCardTabIndex(1, 0, true), -1);
  assert.equal(marketCardTabIndex(2, 0, false), -1);
});

// ── Negative ────────────────────────────────────────────────────────────────

test("cancelled cards are not navigable", () => {
  assert.equal(
    isMarketCardNavigable({ id: "9", state: "cancelled" }),
    false,
  );
});

test("stale and duplicated cards are skipped by arrow navigation", () => {
  const items = cards([
    { id: "1", state: "open" },
    { id: "2", state: "stale" },
    { id: "3", state: "duplicated" },
    { id: "4", state: "accepted" },
  ]);
  assert.equal(
    resolveNextMarketCardIndex({
      items,
      currentIndex: 0,
      key: "ArrowRight",
      columns: 4,
    }),
    3,
  );
});

test("explicitly disabled cards (dependency failure) are skipped", () => {
  const items = cards([
    { id: "1", state: "open" },
    { id: "2", state: "open", disabled: true },
    { id: "3", state: "open" },
  ]);
  assert.equal(
    resolveNextMarketCardIndex({
      items,
      currentIndex: 0,
      key: "ArrowRight",
      columns: 3,
    }),
    2,
  );
});

test("hidden cards and missing ids drop out of the sequence", () => {
  const items = buildMarketCardNavItems([
    { id: "1", state: "open" },
    { id: null, state: "open" },
    { id: "3", state: "open", hidden: true },
    { id: "4", state: "open" },
  ]);
  assert.equal(items[1]!.hidden, true);
  assert.equal(
    resolveNextMarketCardIndex({
      items,
      currentIndex: 0,
      key: "ArrowRight",
      columns: 4,
    }),
    3,
  );
});

test("unrelated keys do not move or activate", () => {
  const items = cards(["1", "2"]);
  const decision = decideMarketCardKey("Escape", {
    items,
    currentIndex: 0,
    columns: 2,
  });
  assert.equal(decision.type, "none");
  assert.equal(decision.preventDefault, false);
  assert.equal(isMarketCardNavKey("Escape"), false);
  assert.equal(shouldActivateMarketCard("Tab"), false);
});

// ── Boundary ────────────────────────────────────────────────────────────────

test("arrow left at the first card is a no-op boundary", () => {
  const items = cards(["1", "2"]);
  assert.equal(
    resolveNextMarketCardIndex({
      items,
      currentIndex: 0,
      key: "ArrowLeft",
      columns: 2,
    }),
    0,
  );
});

test("arrow right at the last card is a no-op boundary", () => {
  const items = cards(["1", "2"]);
  assert.equal(
    resolveNextMarketCardIndex({
      items,
      currentIndex: 1,
      key: "ArrowRight",
      columns: 2,
    }),
    1,
  );
});

test("arrow up on the first row stays put", () => {
  const items = cards(["1", "2", "3"]);
  assert.equal(
    resolveNextMarketCardIndex({
      items,
      currentIndex: 2,
      key: "ArrowUp",
      columns: 3,
    }),
    2,
  );
});

test("arrow down on the last row stays put", () => {
  const items = cards(["1", "2", "3"]);
  assert.equal(
    resolveNextMarketCardIndex({
      items,
      currentIndex: 1,
      key: "ArrowDown",
      columns: 3,
    }),
    1,
  );
});

test("empty grid returns -1", () => {
  assert.equal(
    resolveNextMarketCardIndex({
      items: [],
      currentIndex: 0,
      key: "ArrowRight",
      columns: 3,
    }),
    -1,
  );
});

test("all non-navigable cards return -1", () => {
  const items = cards([
    { id: "1", state: "cancelled" },
    { id: "2", state: "stale" },
  ]);
  assert.equal(
    resolveNextMarketCardIndex({
      items,
      currentIndex: 0,
      key: "Home",
      columns: 2,
    }),
    -1,
  );
});

test("invalid column counts clamp to 1", () => {
  const items = cards(["1", "2", "3"]);
  assert.equal(
    resolveNextMarketCardIndex({
      items,
      currentIndex: 0,
      key: "ArrowDown",
      columns: 0,
    }),
    1,
  );
  assert.equal(inferGridColumns(0, 3), 1);
  assert.equal(inferGridColumns(null, 5), 1);
});

test("resolved cards remain navigable for settlement details", () => {
  assert.equal(
    isMarketCardNavigable({ id: "7", state: "resolved" }),
    true,
  );
});

// ── Regression ──────────────────────────────────────────────────────────────

test("normalizeMarketCardState is case-insensitive and trims", () => {
  assert.equal(normalizeMarketCardState("  CANCELLED "), "cancelled");
  assert.equal(normalizeMarketCardState(undefined), "unknown");
});

test("arrow right skips a cancelled card between two open markets", () => {
  const items = cards([
    { id: "10", state: "open" },
    { id: "11", state: "cancelled" },
    { id: "12", state: "pending" },
  ]);
  const decision = decideMarketCardKey("ArrowRight", {
    items,
    currentIndex: 0,
    columns: 3,
  });
  assert.equal(decision.type, "move");
  assert.equal(decision.nextIndex, 2);
  assert.equal(decision.preventDefault, true);
});

test("when focus sits on a disabled card, Home recovers to the first open card", () => {
  const items = cards([
    { id: "1", state: "open" },
    { id: "2", state: "open", disabled: true },
    { id: "3", state: "accepted" },
  ]);
  assert.equal(
    resolveNextMarketCardIndex({
      items,
      currentIndex: 1,
      key: "Home",
      columns: 3,
    }),
    0,
  );
});

test("buildMarketCardNavItems stringifies numeric market ids", () => {
  const items = buildMarketCardNavItems([{ id: 84, state: "Open" }]);
  assert.equal(items[0]!.id, "84");
  assert.equal(items[0]!.state, "open");
  assert.equal(isMarketCardNavigable(items[0]!), true);
});

test("decideMarketCardKey move is a no-op at the boundary (no preventDefault)", () => {
  const items = cards(["1"]);
  const decision = decideMarketCardKey("ArrowLeft", {
    items,
    currentIndex: 0,
    columns: 1,
  });
  assert.equal(decision.type, "none");
  assert.equal(decision.nextIndex, 0);
  assert.equal(decision.preventDefault, false);
});
