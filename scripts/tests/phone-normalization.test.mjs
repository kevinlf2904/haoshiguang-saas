import test from "node:test";
import assert from "node:assert/strict";
import { normalizePhoneNumber } from "../../src/lib/phone-normalization.mjs";

test("normalizes formatted Taiwan phone numbers before checkout validation and rate limiting", () => {
  assert.equal(normalizePhoneNumber("0912-345-678"), "0912345678");
  assert.equal(normalizePhoneNumber("(02) 2345-6789"), "0223456789");
  assert.equal(normalizePhoneNumber(" 09 12 345 678 "), "0912345678");
  assert.equal(normalizePhoneNumber(""), "");
});
