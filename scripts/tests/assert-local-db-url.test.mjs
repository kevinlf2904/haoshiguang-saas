import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const validator = new URL("../assert-local-db-url.mjs", import.meta.url);

function check(url) {
  return spawnSync(process.execPath, [validator, url], { encoding: "utf8" });
}

test("accepts exact local PostgreSQL hosts", () => {
  for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
    const result = check(`postgresql://user:pass@${host}:5432/test_db`);
    assert.equal(result.status, 0, result.stderr);
  }
});

test("rejects hostname suffix and prefix lookalikes", () => {
  for (const host of [
    "localhost.attacker.example",
    "127.0.0.1.attacker.example",
    "notlocalhost",
    "evil-localhost.example",
    "db.example.supabase.co",
  ]) {
    const result = check(`postgresql://user:pass@${host}:5432/test_db`);
    assert.equal(result.status, 2, host);
  }
});

test("rejects libpq host override parameters", () => {
  for (const parameter of ["host=remote.example", "hostaddr=203.0.113.10", "service=remote"]) {
    const result = check(`postgresql://localhost:5432/test_db?${parameter}`);
    assert.equal(result.status, 2, parameter);
  }
});

test("rejects non-PostgreSQL schemes and malformed URLs", () => {
  assert.equal(check("https://localhost/test").status, 2);
  assert.equal(check("not-a-url").status, 2);
});
