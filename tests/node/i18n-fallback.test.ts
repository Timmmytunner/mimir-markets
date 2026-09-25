import assert from "node:assert/strict";
import test from "node:test";
import { deepMerge } from "../../i18n/request";

test("deepMerge combines objects and falls back to target when source is missing", () => {
  const target = {
    explore: {
      noResults: "No results",
      stale: "Stale cache",
      nested: {
        value: 1
      }
    },
    common: {
      back: "Back"
    }
  };

  const source = {
    explore: {
      noResults: "Sin resultados",
      nested: {
        value: 2
      }
    }
  };

  const result = deepMerge(target, source);

  // Positive: overriding values
  assert.equal(result.explore.noResults, "Sin resultados");
  assert.equal(result.explore.nested.value, 2);

  // Negative / Boundary: missing values in source use target
  assert.equal(result.explore.stale, "Stale cache");
  assert.equal(result.common.back, "Back");

  // Arrays and non-objects
  assert.deepEqual(deepMerge([1, 2], [3, 4]), [3, 4]);
  assert.equal(deepMerge("test", "test2"), "test2");
  assert.equal(deepMerge("test", undefined), "test");
});
