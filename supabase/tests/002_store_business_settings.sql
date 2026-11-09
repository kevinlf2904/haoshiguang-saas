-- Integration assertions for the canonical store_settings model.
-- Run only against the disposable local PostgreSQL service from test-merchant-db.sh.
\set ON_ERROR_STOP on

insert into auth.users(id) values
 ('10000000-0000-4000-8000-000000000001'),
 ('10000000-0000-4000-8000-000000000002'),
 ('10000000-0000-4000-8000-000000000003'),
 ('20000000-0000-4000-8000-000000000001')
on conflict do nothing;

insert into public.tenants(id,name,slug) values
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','測試店 A','test-store-a'),
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','測試店 B','test-store-b')
on conflict (id) do nothing;

insert into public.memberships(tenant_id,user_id,role) values
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','10000000-0000-4000-8000-000000000001','owner'),
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','10000000-0000-4000-8000-000000000002','manager'),
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','10000000-0000-4000-8000-000000000003','staff'),
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','20000000-0000-4000-8000-000000000001','owner')
on conflict (tenant_id,user_id) do nothing;

insert into public.store_settings(tenant_id)
select id from public.tenants
on conflict (tenant_id) do nothing;

-- Tenant B catalog fixtures are used to verify that tenant A cannot mutate them.
insert into public.categories(tenant_id,name)
values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','B 專屬分類')
on conflict (tenant_id,name) do nothing;
insert into public.products(tenant_id,category_id,name,price)
select c.tenant_id,c.id,'B 專屬商品',99
from public.categories c
where c.tenant_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' and c.name='B 專屬分類'
on conflict (tenant_id,category_id,name) do nothing;

-- Orders and customer details are private to each tenant.
insert into public.orders(tenant_id,customer_name,customer_phone,fulfillment,subtotal,total)
values
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','店家 A 顧客','0911111111','takeaway',100,100),
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','店家 B 顧客','0922222222','takeaway',200,200);
insert into public.order_items(order_id,tenant_id,product_name,unit_price,quantity,line_total)
select o.id,o.tenant_id,'隔離測試商品',o.total,1,o.total
from public.orders o
where o.customer_name in ('店家 A 顧客','店家 B 顧客');

do $$
begin
  if has_table_privilege('anon','public.orders','SELECT')
     or has_table_privilege('anon','public.order_items','SELECT') then
    raise exception 'anon must not have direct SELECT privilege on orders or order_items';
  end if;
end $$;

-- Public anon reads only active tenants' settings; inactive tenant data stays hidden.
update public.tenants set is_active=false
where id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
set role anon;
do $$
declare visible_count integer;
begin
  select count(*) into visible_count
  from public.store_settings
  where tenant_id in (
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  );
  if visible_count <> 1 then
    raise exception 'anon must read active tenant settings and must not read inactive tenant settings';
  end if;
  if not exists (
    select 1 from public.tenants
    where id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' and is_active
  ) then raise exception 'anon should read active public tenant'; end if;
  if exists (
    select 1 from public.tenants
    where id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  ) then raise exception 'anon must not read inactive tenant'; end if;
end $$;
reset role;

-- Owner can update its own tenant settings.
set role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000001',false);
do $block$
declare own_orders integer; foreign_orders integer; own_items integer; foreign_items integer; affected integer;
begin
  select count(*) into own_orders from public.orders where customer_name='店家 A 顧客';
  select count(*) into foreign_orders from public.orders where customer_name='店家 B 顧客';
  select count(*) into own_items from public.order_items oi join public.orders o on o.id=oi.order_id where o.customer_name='店家 A 顧客';
  select count(*) into foreign_items from public.order_items oi join public.orders o on o.id=oi.order_id where o.customer_name='店家 B 顧客';
  if own_orders <> 1 or foreign_orders <> 0 or own_items <> 1 or foreign_items <> 0 then
    raise exception 'tenant A must read only its own orders and order items';
  end if;
  update public.orders set status='cancelled' where customer_name='店家 B 顧客';
  get diagnostics affected = row_count;
  if affected <> 0 then
    raise exception 'tenant A must not update tenant B orders';
  end if;
end $block$;
do $block$
declare affected integer;
begin
  update public.store_settings set prep_time_minutes=25
  where tenant_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  get diagnostics affected = row_count;
  if affected <> 1 then raise exception 'owner should update own tenant settings'; end if;

  update public.store_settings set prep_time_minutes=35
  where tenant_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  get diagnostics affected = row_count;
  if affected <> 0 then raise exception 'owner must not update another tenant settings'; end if;
end $block$;

-- Manager can update; staff cannot.
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000002',false);
do $$
declare affected integer;
begin
  update public.store_settings set prep_time_minutes=30
  where tenant_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  get diagnostics affected = row_count;
  if affected <> 1 then raise exception 'manager should update own tenant settings'; end if;
end $$;

select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000003',false);
do $$
declare affected integer;
begin
  update public.store_settings set prep_time_minutes=45
  where tenant_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  get diagnostics affected = row_count;
  if affected <> 0 then raise exception 'staff must not update store settings'; end if;
end $$;
reset role;

-- INSERT is limited to owner/manager membership; staff and another tenant's owner are denied.
set role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000003',false);
do $$
begin
  begin
    insert into public.store_settings(tenant_id)
    values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    raise exception 'TEST_EXPECTED_STAFF_INSERT_DENIAL_NOT_RAISED';
  exception when insufficient_privilege then
    null;
  end;
end $$;

select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000001',false);
do $$
begin
  begin
    insert into public.store_settings(tenant_id)
    values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    raise exception 'TEST_EXPECTED_CROSS_TENANT_INSERT_DENIAL_NOT_RAISED';
  exception when insufficient_privilege then
    null;
  end;
end $$;

-- DELETE is intentionally unavailable to staff and owners, including cross-tenant targets.
do $$
begin
  if has_table_privilege(current_user, 'public.store_settings', 'DELETE') then
    raise exception 'authenticated role must not have DELETE privilege on store_settings';
  end if;
  begin
    delete from public.store_settings
    where tenant_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    raise exception 'TEST_EXPECTED_STAFF_DELETE_DENIAL_NOT_RAISED';
  exception when insufficient_privilege then
    null;
  end;
end $$;

select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000001',false);
do $$
begin
  begin
    delete from public.store_settings
    where tenant_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    raise exception 'TEST_EXPECTED_CROSS_TENANT_DELETE_DENIAL_NOT_RAISED';
  exception when insufficient_privilege then
    null;
  end;
end $$;
reset role;

-- Weekly-hours validation: valid split shifts pass; overlapping or malformed slots fail.
do $$
begin
  if not public.is_valid_weekly_hours('{"mon":[{"open":"11:00","close":"14:00"},{"open":"17:00","close":"20:00"}]}'::jsonb) then
    raise exception 'valid split-shift schedule rejected';
  end if;
  if public.is_valid_weekly_hours('{"mon":[{"open":"11:00","close":"14:00"},{"open":"13:00","close":"20:00"}]}'::jsonb) then
    raise exception 'overlapping schedule accepted';
  end if;
  if public.is_valid_weekly_hours('{"mon":[{"open":"25:00","close":"26:00"}]}'::jsonb) then
    raise exception 'malformed time accepted';
  end if;
end $$;

-- The opening boundary is inclusive and the closing boundary is exclusive.
do $$
declare slots jsonb := '[{"open":"11:00","close":"14:00"}]'::jsonb;
begin
  if not public.is_within_business_slots(slots, time '11:00') then
    raise exception 'opening boundary must be inclusive';
  end if;
  if not public.is_within_business_slots(slots, time '13:59:59') then
    raise exception 'time before closing boundary must be open';
  end if;
  if public.is_within_business_slots(slots, time '14:00') then
    raise exception 'closing boundary must be exclusive';
  end if;
end $$;

-- Ensure the checkout RPC rejects a paused store, a holiday, and a closed weekly interval.
update public.store_settings
set is_accepting_orders=false, closed_dates='{}'::date[], weekly_hours='{}'::jsonb
where tenant_id=(select id from public.tenants where slug='laozhang');

do $$
begin
  begin
    perform public.create_public_order('laozhang','測試顧客','0912345678','takeaway',null,'',
      '[{"product_name":"海鮮湯麵","category_name":"湯麵類","quantity":1}]'::jsonb, '44444444-4444-4444-8444-000000000001'::uuid, repeat('d',64), repeat('e',64), repeat('d',64));
    raise exception 'TEST_EXPECTED_PAUSED_REJECTION_NOT_RAISED';
  exception when others then
    if sqlerrm='TEST_EXPECTED_PAUSED_REJECTION_NOT_RAISED' then raise; end if;
    if position('store_unavailable' in sqlerrm)=0 then raise; end if;
  end;
end $$;

update public.store_settings
set is_accepting_orders=true,
    closed_dates=array[(now() at time zone 'Asia/Taipei')::date],
    weekly_hours='{}'::jsonb
where tenant_id=(select id from public.tenants where slug='laozhang');

do $$
begin
  begin
    perform public.create_public_order('laozhang','測試顧客','0912345678','takeaway',null,'',
      '[{"product_name":"海鮮湯麵","category_name":"湯麵類","quantity":1}]'::jsonb, '44444444-4444-4444-8444-000000000002'::uuid, repeat('d',64), repeat('e',64), repeat('d',64));
    raise exception 'TEST_EXPECTED_HOLIDAY_REJECTION_NOT_RAISED';
  exception when others then
    if sqlerrm='TEST_EXPECTED_HOLIDAY_REJECTION_NOT_RAISED' then raise; end if;
    if position('store_closed' in sqlerrm)=0 then raise; end if;
  end;
end $$;

-- The current local weekday is configured to a time window that cannot include now.
update public.store_settings
set closed_dates='{}'::date[],
    weekly_hours=jsonb_build_object(
      case extract(isodow from now() at time zone 'Asia/Taipei')::integer
        when 1 then 'mon' when 2 then 'tue' when 3 then 'wed'
        when 4 then 'thu' when 5 then 'fri' when 6 then 'sat' else 'sun' end,
      case when (now() at time zone 'Asia/Taipei')::time < time '12:00'
        then '[{"open":"23:58","close":"23:59"}]'::jsonb
        else '[{"open":"00:00","close":"00:01"}]'::jsonb end
    )
where tenant_id=(select id from public.tenants where slug='laozhang');

do $$
begin
  begin
    perform public.create_public_order('laozhang','測試顧客','0912345678','takeaway',null,'',
      '[{"product_name":"海鮮湯麵","category_name":"湯麵類","quantity":1}]'::jsonb, '44444444-4444-4444-8444-000000000003'::uuid, repeat('d',64), repeat('e',64), repeat('d',64));
    raise exception 'TEST_EXPECTED_OUTSIDE_HOURS_REJECTION_NOT_RAISED';
  exception when others then
    if sqlerrm='TEST_EXPECTED_OUTSIDE_HOURS_REJECTION_NOT_RAISED' then raise; end if;
    if position('store_closed' in sqlerrm)=0 then raise; end if;
  end;
end $$;


-- An open store accepts a valid order and calculates price from the database.
update public.store_settings
set closed_dates='{}'::date[], weekly_hours='{}'::jsonb, is_accepting_orders=true
where tenant_id=(select id from public.tenants where slug='laozhang');

do $$
declare result jsonb;
begin
  result := public.create_public_order('laozhang','測試顧客','0912345678','takeaway',null,'',
    '[{"product_name":"海鮮湯麵","category_name":"湯麵類","quantity":1}]'::jsonb, '44444444-4444-4444-8444-000000000004'::uuid, repeat('d',64), repeat('e',64), repeat('d',64));
  if (result ->> 'total')::integer <> 180 then
    raise exception 'checkout must calculate the catalog price from database rows';
  end if;
end $$;

-- A manually sold-out product must be rejected by the same server-side RPC.
update public.products set is_available=false
where tenant_id=(select id from public.tenants where slug='laozhang') and name='海鮮湯麵';

do $$
begin
  begin
    perform public.create_public_order('laozhang','測試顧客','0912345678','takeaway',null,'',
      '[{"product_name":"海鮮湯麵","category_name":"湯麵類","quantity":1}]'::jsonb, '44444444-4444-4444-8444-000000000005'::uuid, repeat('d',64), repeat('e',64), repeat('d',64));
    raise exception 'TEST_EXPECTED_SOLD_OUT_REJECTION_NOT_RAISED';
  exception when others then
    if sqlerrm='TEST_EXPECTED_SOLD_OUT_REJECTION_NOT_RAISED' then raise; end if;
    if position('item_unavailable_or_invalid' in sqlerrm)=0 then raise; end if;
  end;
end $$;
