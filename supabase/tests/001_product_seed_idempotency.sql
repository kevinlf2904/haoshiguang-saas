-- Run only against a disposable local PostgreSQL database after migration 0001/0002.
-- The companion scripts/test-db.sh enforces a localhost-only TEST_DATABASE_URL.
\set ON_ERROR_STOP on

-- Confirm seed is repeatable and keeps an operator's manual sold-out state.
update public.products
set is_available = false
where tenant_id = (select id from public.tenants where slug = 'laozhang')
  and category_id = (
    select c.id from public.categories c
    join public.tenants t on t.id = c.tenant_id
    where t.slug = 'laozhang' and c.name = '湯麵類'
  )
  and name = '海鮮湯麵';

\ir ../seed/001_laozhang_pilot.sql

do $$
declare
  product_count integer;
  unavailable_count integer;
  duplicate_rejected boolean := false;
  tenant_two uuid;
  category_two uuid;
  tenant_one uuid;
  category_one uuid;
begin
  select count(*) into product_count
  from public.products p join public.tenants t on t.id = p.tenant_id
  where t.slug = 'laozhang';
  if product_count <> 27 then
    raise exception 'Expected 27 pilot products after repeated seed, got %', product_count;
  end if;

  select count(*) into unavailable_count
  from public.products p
  join public.tenants t on t.id = p.tenant_id
  join public.categories c on c.id = p.category_id
  where t.slug = 'laozhang'
    and c.name = '湯麵類'
    and p.name = '海鮮湯麵'
    and p.is_available = false;
  if unavailable_count <> 1 then
    raise exception 'Seed re-enabled manually unavailable product';
  end if;

  select id into tenant_one from public.tenants where slug = 'laozhang';
  select id into category_one from public.categories
    where tenant_id = tenant_one and name = '湯麵類';

  begin
    insert into public.products(tenant_id, category_id, name, price)
    values (tenant_one, category_one, '海鮮湯麵', 999);
  exception when unique_violation then
    duplicate_rejected := true;
  end;
  if not duplicate_rejected then
    raise exception 'Expected duplicate product in same tenant/category to be rejected';
  end if;

  insert into public.tenants(name, slug, currency)
  values ('Identity test tenant', 'identity-test-tenant', 'TWD')
  on conflict (slug) do nothing;
  select id into tenant_two from public.tenants where slug = 'identity-test-tenant';

  insert into public.categories(tenant_id, name)
  values (tenant_two, '湯麵類')
  on conflict (tenant_id, name) do nothing;
  select id into category_two from public.categories
    where tenant_id = tenant_two and name = '湯麵類';

  insert into public.products(tenant_id, category_id, name, price)
  values (tenant_two, category_two, '海鮮湯麵', 180)
  on conflict (tenant_id, category_id, name) do nothing;

  if not exists (
    select 1 from public.products
    where tenant_id = tenant_two and category_id = category_two and name = '海鮮湯麵'
  ) then
    raise exception 'Same product name in a different tenant should be allowed';
  end if;

  raise notice 'PASS: seed idempotency, availability preservation, same-tenant uniqueness, cross-tenant duplicate name';
end
$$;
