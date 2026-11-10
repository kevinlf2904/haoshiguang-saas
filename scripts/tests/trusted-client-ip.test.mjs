import test from "node:test";
import assert from "node:assert/strict";
import { getTrustedVercelClientIp } from "../../src/lib/trusted-client-ip.mjs";

function makeHeaders(values = {}) {
  return {
    get(name) {
      return Object.hasOwn(values, name) ? values[name] : null;
    },
  };
}

test("accepts and preserves a valid Vercel IPv4 address", () => {
  assert.equal(
    getTrustedVercelClientIp(makeHeaders({ "x-vercel-forwarded-for": "203.0.113.8" })),
    "203.0.113.8",
  );
});

test("canonicalizes IPv6 addresses before hashing", () => {
  assert.equal(
    getTrustedVercelClientIp(makeHeaders({
      "x-vercel-forwarded-for": "2001:0DB8:0000:0000:0000:0000:0000:0001",
    })),
    "2001:db8::1",
  );
});

test("does not fall back to a client-supplied x-forwarded-for header", () => {
  assert.equal(
    getTrustedVercelClientIp(makeHeaders({ "x-forwarded-for": "198.51.100.77" })),
    null,
  );
});

test("ignores a spoofed x-forwarded-for when the Vercel header is present", () => {
  assert.equal(
    getTrustedVercelClientIp(makeHeaders({
      "x-vercel-forwarded-for": "203.0.113.8",
      "x-forwarded-for": "198.51.100.77",
    })),
    "203.0.113.8",
  );
});

test("rejects empty, malformed, chained, whitespace and oversized values", () => {
  for (const value of [
    "",
    "not-an-ip",
    "203.0.113.8, 198.51.100.77",
    " 203.0.113.8",
    "203.0.113.8 ",
    "2001:db8::1%eth0",
    "a".repeat(46),
  ]) {
    assert.equal(
      getTrustedVercelClientIp(makeHeaders({ "x-vercel-forwarded-for": value })),
      null,
      `expected rejection for ${JSON.stringify(value)}`,
    );
  }
});
