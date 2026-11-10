import test from "node:test";
import assert from "node:assert/strict";
import { isAuthorizedCronRequest } from "../../src/lib/cron-auth.mjs";

test("cron authorization fails closed for missing or malformed credentials", () => {
  assert.equal(isAuthorizedCronRequest(null, "long-random-secret"), false);
  assert.equal(isAuthorizedCronRequest("Bearer wrong-secret", "long-random-secret"), false);
  assert.equal(isAuthorizedCronRequest("Basic long-random-secret", "long-random-secret"), false);
  assert.equal(isAuthorizedCronRequest("Bearer  long-random-secret", "long-random-secret"), false);
  assert.equal(isAuthorizedCronRequest("Bearer long-random-secret", ""), false);
  assert.equal(isAuthorizedCronRequest("Bearer long-random-secret-extra", "long-random-secret"), false);
});

test("cron authorization accepts the exact configured bearer secret", () => {
  assert.equal(isAuthorizedCronRequest("Bearer long-random-secret", "long-random-secret"), true);
});
