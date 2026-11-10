#!/usr/bin/env bash
set -euo pipefail

: "${TEST_DATABASE_URL:?Set TEST_DATABASE_URL to a disposable localhost PostgreSQL database}"

# Refuse non-loopback hosts and libpq host overrides before invoking psql.
node - "${TEST_DATABASE_URL}" <<'NODE'
const value = process.argv[2];
let url;
try { url = new URL(value); } catch { throw new Error("Malformed TEST_DATABASE_URL"); }
if (!["postgres:", "postgresql:"].includes(url.protocol)) throw new Error("Only PostgreSQL URLs are allowed");
if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw new Error("Database host must be exact localhost/loopback");
if (url.hash || ["host", "hostaddr", "service", "servicefile"].some(key => url.searchParams.has(key))) {
  throw new Error("Database URL overrides/fragments are not allowed");
}
NODE

command -v psql >/dev/null 2>&1 || { echo "psql is required" >&2; exit 2; }

psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
create schema if not exists auth;
create table if not exists auth.users (id uuid primary key);
create or replace function auth.uid()
returns uuid language sql stable
as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;
grant usage on schema auth to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;
SQL

echo "Applying isolated schema migrations..."
psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/migrations/20261109000100_initial.sql
psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/migrations/20261109000200_product_identity_unique.sql
psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/migrations/20261109000300_secure_public_checkout.sql
psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/migrations/20261109000400_merchant_catalog_permissions.sql
psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/migrations/20261109000500_store_business_settings.sql
psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/migrations/20261109000600_checkout_order_hardening.sql
psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/migrations/20261109000700_checkout_retention.sql
psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/migrations/20261110000100_merchant_store_profile.sql
psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/migrations/20261110000200_public_order_tracking.sql
psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/migrations/20261110000300_order_retention_scheduler.sql
psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/migrations/20261111000100_pilot_owner_and_membership_invites.sql

echo "Seeding pilot catalog..."
psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/seed/001_laozhang_pilot.sql

echo "Testing tenant RLS, operating-hours validation, and checkout rejection..."
psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/002_store_business_settings.sql
psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/003_checkout_order_hardening.sql
psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/004_merchant_store_profile.sql
psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/005_public_order_tracking.sql
psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/006_order_retention_scheduler.sql
psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/007_pilot_owner_bootstrap.sql
bash scripts/test-checkout-concurrency.sh

echo "PASS: isolated PostgreSQL business-settings/RLS/checkout/concurrency tests completed."
