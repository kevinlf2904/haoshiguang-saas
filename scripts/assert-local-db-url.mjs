#!/usr/bin/env node
import { URL } from "node:url";

const value = process.argv[2] ?? "";

function reject(reason) {
  console.error(`Refusing to run: ${reason}`);
  process.exit(2);
}

let parsed;
try {
  parsed = new URL(value);
} catch {
  reject("TEST_DATABASE_URL must be a valid PostgreSQL URL.");
}

if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
  reject("TEST_DATABASE_URL must use the postgres:// or postgresql:// scheme.");
}

const allowedHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
if (!allowedHosts.has(parsed.hostname.toLowerCase())) {
  reject("TEST_DATABASE_URL hostname must exactly equal localhost, 127.0.0.1, or ::1.");
}

// libpq URI parameters can override the authority hostname. Disallow these
// alternate connection selectors so a localhost-looking URL cannot redirect.
for (const key of parsed.searchParams.keys()) {
  if (["host", "hostaddr", "service", "servicefile"].includes(key.toLowerCase())) {
    reject(`TEST_DATABASE_URL may not contain the libpq ${key} parameter.`);
  }
}

if (parsed.hash) {
  reject("TEST_DATABASE_URL must not contain a URL fragment.");
}

