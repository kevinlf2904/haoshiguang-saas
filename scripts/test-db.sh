#!/usr/bin/env bash
set -euo pipefail

: "${TEST_DATABASE_URL:?Set TEST_DATABASE_URL to a disposable local PostgreSQL database}"

# Never permit a hosted Supabase/PostgreSQL endpoint for this test helper.
case "$TEST_DATABASE_URL" in
  *localhost*|*127.0.0.1*|*\[::1\]*) ;;
  *)
    echo "Refusing to run: TEST_DATABASE_URL must point to localhost/127.0.0.1/::1." >&2
    exit 2
    ;;
esac

command -v psql >/dev/null 2>&1 || {
  echo "psql is required. Install PostgreSQL client tools first." >&2
  exit 2
}

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
