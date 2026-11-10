#!/usr/bin/env bash
set -euo pipefail

: "${TEST_DATABASE_URL:?Set TEST_DATABASE_URL to a disposable local PostgreSQL database}"

# Validate the parsed authority hostname exactly. Do this before checking for
# psql or making any database connection.
node scripts/assert-local-db-url.mjs "$TEST_DATABASE_URL"

command -v psql >/dev/null 2>&1 || {
  echo "psql is required. Install PostgreSQL client tools first." >&2
  exit 2
}

# Provide only the Supabase Auth surface referenced by migration 0001.
# This runs exclusively against the disposable localhost database above; it
# does not connect to or modify a hosted Supabase project.
echo "Preparing minimal local Supabase Auth test fixtures..."
psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
create schema if not exists auth;

create table if not exists auth.users (
  id uuid primary key
);

create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
end
$$;

grant usage on schema auth to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;
SQL

echo "Applying migration 0001..."
psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/migrations/0001_initial.sql
echo "Applying migration 0002..."
psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/migrations/0002_product_identity_unique.sql
echo "Running pilot seed twice..."
psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/seed/001_laozhang_pilot.sql
psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/seed/001_laozhang_pilot.sql
echo "Running assertions (includes a further seed rerun after manual sell-out)..."
psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/001_product_seed_idempotency.sql
echo "PASS: local PostgreSQL migration + repeated seed tests completed."
