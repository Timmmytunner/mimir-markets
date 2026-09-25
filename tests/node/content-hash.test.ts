import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeHash32Hex,
  isHash32Hex,
  sha256Hex,
} from "../../lib/content-hash";

test("decodeHash32Hex accepts exact 32-byte digests with either hex convention", () => {
  const digest = sha256Hex("auditable evidence");

  assert.equal(decodeHash32Hex(digest).length, 32);
  assert.equal(decodeHash32Hex(`0x${digest}`).toString("hex"), digest);
  assert.equal(decodeHash32Hex(digest.toUpperCase()).toString("hex"), digest);
  assert.equal(isHash32Hex(digest), true);
});

test("decodeHash32Hex rejects hashes either side of the 32-byte boundary", () => {
  for (const malformed of [
    "ab".repeat(31),
    "ab".repeat(33),
    `0x${"ab".repeat(31)}`,
    `0x${"ab".repeat(33)}`,
  ]) {
    assert.throws(
      () => decodeHash32Hex(malformed, "evidence_hash"),
      /evidence_hash must be exactly 32 bytes/,
    );
  }
});

test("decodeHash32Hex rejects empty, odd-length, and non-hex evidence", () => {
  for (const malformed of ["", "0x", "a".repeat(63), `${"ab".repeat(31)}zz`]) {
    assert.throws(
      () => decodeHash32Hex(malformed, "evidence_hash"),
      /64 hexadecimal characters/,
    );
  }
});
