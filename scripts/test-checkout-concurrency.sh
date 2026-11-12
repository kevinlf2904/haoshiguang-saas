#!/usr/bin/env bash
set -euo pipefail

: "${TEST_DATABASE_URL:?Set TEST_DATABASE_URL to a disposable localhost PostgreSQL database}"
node scripts/assert-local-db-url.mjs "$TEST_DATABASE_URL"
command -v psql >/dev/null 2>&1 || { echo "psql is required" >&2; exit 2; }

tmp="$(mktemp -d)"
cleanup() { rm -rf "$tmp"; }
trap cleanup EXIT

wait_for_file() {
  local path="$1"
  for _ in $(seq 1 50); do
    [[ -f "$path" ]] && return 0
    sleep 0.1
  done
  echo "Timed out waiting for concurrent transaction barrier: $path" >&2
  return 1
}

echo "Testing concurrent idempotency requests..."
(
  psql "$TEST_DATABASE_URL" -X -qAt -v ON_ERROR_STOP=1 >"$tmp/idem-a.out" <<SQL
begin;
select pg_advisory_xact_lock(hashtextextended(
  (select id::text from public.tenants where slug='laozhang') || ':idem:77777777-7777-4777-8777-777777777773', 0
));
select public.create_public_order(
  'laozhang','併發冪等測試','09122223333','takeaway',null,'',
  '[{"product_name":"白飯","category_name":"飯類","quantity":1}]'::jsonb,
  '77777777-7777-4777-8777-777777777773'::uuid, repeat('a',64), repeat('b',64), repeat('c',64)
);
\! touch "$tmp/idem-ready"
select pg_sleep(2);
commit;
SQL
) &
idem_pid=$!
wait_for_file "$tmp/idem-ready"
psql "$TEST_DATABASE_URL" -X -qAt -v ON_ERROR_STOP=1 >"$tmp/idem-b.out" <<'SQL'
select public.create_public_order(
  'laozhang','併發冪等測試','09122223333','takeaway',null,'',
  '[{"product_name":"白飯","category_name":"飯類","quantity":1}]'::jsonb,
  '77777777-7777-4777-8777-777777777773'::uuid, repeat('a',64), repeat('b',64), repeat('c',64)
);
SQL
wait "$idem_pid"
node - "$tmp/idem-a.out" "$tmp/idem-b.out" <<'NODE'
const fs = require("node:fs");
const ids = process.argv.slice(2).map((p) => {
  const match = fs.readFileSync(p, "utf8").match(/"id"\s*:\s*"([^"]+)"/);
  if (!match) throw new Error("Concurrent checkout did not return an order id");
  return match[1];
});
if (ids[0] !== ids[1]) throw new Error("Concurrent idempotency requests created different orders");
NODE
idem_count="$(psql "$TEST_DATABASE_URL" -X -qAt -v ON_ERROR_STOP=1 -c "select count(*) from public.public_order_idempotency where idempotency_key='77777777-7777-4777-8777-777777777773'")"
[[ "$idem_count" == "1" ]] || { echo "Expected exactly one idempotency row, got $idem_count" >&2; exit 1; }

echo "Testing price update racing with checkout..."
old_price="$(psql "$TEST_DATABASE_URL" -X -qAt -v ON_ERROR_STOP=1 -c "select p.price from public.products p join public.categories c on c.id=p.category_id and c.tenant_id=p.tenant_id where p.tenant_id=(select id from public.tenants where slug='laozhang') and p.name='白飯' and c.name='飯類' and p.is_available")"
[[ "$old_price" =~ ^[0-9]+$ ]] || { echo "Could not resolve an available pilot rice product" >&2; exit 1; }
expected_price=$((old_price + 1))
(
  psql "$TEST_DATABASE_URL" -X -qAt -v ON_ERROR_STOP=1 >"$tmp/price-a.out" <<SQL
begin;
update public.products
set price = $expected_price
where tenant_id=(select id from public.tenants where slug='laozhang')
  and name='白飯' and category_id=(select id from public.categories where tenant_id=(select id from public.tenants where slug='laozhang') and name='飯類')
  and is_available=true;
\! touch "$tmp/price-ready"
select pg_sleep(2);
commit;
SQL
) &
price_pid=$!
wait_for_file "$tmp/price-ready"
psql "$TEST_DATABASE_URL" -X -qAt -v ON_ERROR_STOP=1 >"$tmp/price-b.out" <<'SQL'
select public.create_public_order(
  'laozhang','價格競態測試','09122223334','takeaway',null,'',
  '[{"product_name":"白飯","category_name":"飯類","quantity":1}]'::jsonb,
  '88888888-8888-4888-8888-888888888888'::uuid, repeat('d',64), repeat('e',64), repeat('f',64)
);
SQL
wait "$price_pid"
node - "$tmp/price-b.out" "$expected_price" <<'NODE'
const fs = require("node:fs");
const result = JSON.parse(fs.readFileSync(process.argv[2], "utf8").trim().split("\n").filter(Boolean).at(-1));
if (Number(result.total) !== Number(process.argv[3])) {
  throw new Error(`Checkout total ${result.total} did not use committed catalog price ${process.argv[3]}`);
}
NODE
# Restore the catalog fixture so repeated CI runs begin from the seed price.
psql "$TEST_DATABASE_URL" -X -qAt -v ON_ERROR_STOP=1 -c "update public.products set price=$old_price where tenant_id=(select id from public.tenants where slug='laozhang') and name='白飯' and category_id=(select id from public.categories where tenant_id=(select id from public.tenants where slug='laozhang') and name='飯類')"

echo "Testing store pause racing with checkout..."
(
  psql "$TEST_DATABASE_URL" -X -qAt -v ON_ERROR_STOP=1 >"$tmp/store-a.out" <<SQL
begin;
update public.store_settings set is_accepting_orders=false
where tenant_id=(select id from public.tenants where slug='laozhang');
\\! touch "$tmp/store-ready"
select pg_sleep(2);
commit;
SQL
) &
store_pid=$!
wait_for_file "$tmp/store-ready"
if psql "$TEST_DATABASE_URL" -X -qAt -v ON_ERROR_STOP=1 >"$tmp/store-b.out" 2>"$tmp/store-b.err" <<'SQL'
select public.create_public_order(
  'laozhang','營業狀態競態測試','09122223335','takeaway',null,'',
  '[{"product_name":"白飯","category_name":"飯類","quantity":1}]'::jsonb,
  '99999999-9999-4999-8999-999999999999'::uuid, repeat('1',64), repeat('2',64), repeat('3',64)
);
SQL
then
  echo "Checkout unexpectedly succeeded while the store was being paused" >&2
  wait "$store_pid" || true
  exit 1
fi
wait "$store_pid"
grep -q "store_unavailable" "$tmp/store-b.err" || {
  echo "Checkout did not reject using the committed paused-store state" >&2
  cat "$tmp/store-b.err" >&2
  exit 1
}
psql "$TEST_DATABASE_URL" -X -qAt -v ON_ERROR_STOP=1 -c "update public.store_settings set is_accepting_orders=true where tenant_id=(select id from public.tenants where slug='laozhang')"


echo "Testing concurrent tenant-member invitation idempotency..."
invite_tenant="$(psql "$TEST_DATABASE_URL" -X -qAt -v ON_ERROR_STOP=1 -c "select id from public.tenants where slug='laozhang'")"
invite_actor="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1"
invite_target="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2"
invite_email="concurrent-member-invite@example.test"
psql "$TEST_DATABASE_URL" -X -qAt -v ON_ERROR_STOP=1 <<SQL
delete from public.tenant_membership_invites where tenant_id='$invite_tenant' and user_id in ('$invite_actor','$invite_target');
delete from public.memberships where tenant_id='$invite_tenant' and user_id in ('$invite_actor','$invite_target');
delete from auth.users where id in ('$invite_actor','$invite_target');
insert into auth.users(id,email) values
  ('$invite_actor','concurrent-invite-owner@example.test'),
  ('$invite_target','$invite_email');
insert into public.memberships(tenant_id,user_id,role)
values ('$invite_tenant','$invite_actor','owner');
SQL
(
  psql "$TEST_DATABASE_URL" -X -qAt -v ON_ERROR_STOP=1 >"$tmp/member-invite-a.out" <<SQL
begin;
set request.jwt.claim.role = 'service_role';
set request.jwt.claims = '{"role":"service_role"}';
select public.grant_tenant_member_invite(
  '$invite_tenant','$invite_target','$invite_email','staff','$invite_actor'
);
\! touch "$tmp/member-invite-ready"
select pg_sleep(2);
commit;
SQL
) &
invite_pid=$!
wait_for_file "$tmp/member-invite-ready"
psql "$TEST_DATABASE_URL" -X -qAt -v ON_ERROR_STOP=1 >"$tmp/member-invite-b.out" <<SQL
set request.jwt.claim.role = 'service_role';
set request.jwt.claims = '{"role":"service_role"}';
select public.grant_tenant_member_invite(
  '$invite_tenant','$invite_target','$invite_email','staff','$invite_actor'
);
SQL
wait "$invite_pid"
node - "$tmp/member-invite-a.out" "$tmp/member-invite-b.out" <<'NODE'
const fs = require("node:fs");
const results = process.argv.slice(2).map((p) =>
  fs.readFileSync(p, "utf8").trim().split("\n").filter(Boolean).at(-1)
);
if (results[0] !== "t" || results[1] !== "f") {
  throw new Error("Expected concurrent invite results true/false, got " + results.join("/"));
}
NODE
invite_rows="$(psql "$TEST_DATABASE_URL" -X -qAt -v ON_ERROR_STOP=1 -c "select count(*) from public.tenant_membership_invites where tenant_id='$invite_tenant' and normalized_email='$invite_email'")"
member_rows="$(psql "$TEST_DATABASE_URL" -X -qAt -v ON_ERROR_STOP=1 -c "select count(*) from public.memberships where tenant_id='$invite_tenant' and user_id='$invite_target' and role='staff'")"
[[ "$invite_rows" == "1" && "$member_rows" == "1" ]] || {
  echo "Expected one invite and one membership, got invites=$invite_rows memberships=$member_rows" >&2
  exit 1
}
psql "$TEST_DATABASE_URL" -X -qAt -v ON_ERROR_STOP=1 <<SQL
delete from public.tenant_membership_invites where tenant_id='$invite_tenant' and user_id='$invite_target';
delete from public.memberships where tenant_id='$invite_tenant' and user_id in ('$invite_actor','$invite_target');
delete from auth.users where id in ('$invite_actor','$invite_target');
SQL

echo "PASS: concurrent idempotency, catalog-price, store-pause, and member-invite locking tests completed."
