import test from "node:test";
import assert from "node:assert/strict";
import {
  deriveTrackingToken,
  hashTrackingToken,
  loadTrackingKeyRing,
} from "../../src/lib/order-tracking-crypto.ts";

const oldSecret = "old-key-material-that-is-at-least-32-bytes";
const newSecret = "new-key-material-that-is-at-least-32-bytes";

test("key ring rejects missing, malformed, weak, and unknown active configuration", () => {
  assert.equal(loadTrackingKeyRing({}), null);
  assert.equal(loadTrackingKeyRing({
    ORDER_TRACKING_HMAC_KEYS: "{",
    ORDER_TRACKING_HMAC_ACTIVE_KEY_VERSION: "1",
  }), null);
  assert.equal(loadTrackingKeyRing({
    ORDER_TRACKING_HMAC_KEYS: JSON.stringify({ "1": "too-short" }),
    ORDER_TRACKING_HMAC_ACTIVE_KEY_VERSION: "1",
  }), null);
  assert.equal(loadTrackingKeyRing({
    ORDER_TRACKING_HMAC_KEYS: JSON.stringify({ "1": oldSecret }),
    ORDER_TRACKING_HMAC_ACTIVE_KEY_VERSION: "2",
  }), null);
});

test("rotation keeps old tracking tokens verifiable while a previous key remains configured", () => {
  const originalToken = deriveTrackingToken("laozhang", "7f4f3f6a-1c28-4b83-9a34-8c2f4c1b0a11", oldSecret);
  const originalHash = hashTrackingToken(originalToken, oldSecret);
  const ring = loadTrackingKeyRing({
    ORDER_TRACKING_HMAC_KEYS: JSON.stringify({ "1": oldSecret, "2": newSecret }),
    ORDER_TRACKING_HMAC_ACTIVE_KEY_VERSION: "2",
  });
  assert.ok(ring);
  assert.equal(hashTrackingToken(originalToken, ring.keys.get(1)!), originalHash);
  assert.notEqual(
    deriveTrackingToken("laozhang", "7f4f3f6a-1c28-4b83-9a34-8c2f4c1b0a11", newSecret),
    originalToken,
  );
  assert.equal(ring.activeVersion, 2);
});

test("same active key and idempotency key produce the same token", () => {
  const a = deriveTrackingToken("laozhang", "7f4f3f6a-1c28-4b83-9a34-8c2f4c1b0a11", newSecret);
  const b = deriveTrackingToken("laozhang", "7f4f3f6a-1c28-4b83-9a34-8c2f4c1b0a11", newSecret);
  assert.equal(a, b);
  assert.match(hashTrackingToken(a, newSecret), /^[a-f0-9]{64}$/);
});
