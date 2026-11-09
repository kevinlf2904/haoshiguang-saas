-- Store operating hours and order acceptance controls (Taipei local time).
alter table public.tenants
  add column if not exists weekly_hours jsonb not null default
    '{"0":[],"1":[{"open":"11:00","close":"14:00"},{"open":"17:00","close":"20:00"}],"2":[{"open":"11:00","close":"14:00"},{"open":"17:00","close":"20:00"}],"3":[{"open":"11:00","close":"14:00"},{"open":"17:00","close":"20:00"}],"4":[{"open":"11:00","close":"14:00"},{"open":"17:00","close":"20:00"}],"5":[{"open":"11:00","close":"14:00"},{"open":"17:00","close":"20:00"}],"6":[{"open":"11:00","close":"14:00"}]}'::jsonb,
  add column if not exists special_hours jsonb not null default '{}'::jsonb,
  add column if not exists accepting_orders boolean not null default true,
  add column if not exists prep_time_minutes integer not null default 20
    check (prep_time_minutes between 5 and 240);

grant update (weekly_hours, special_hours, accepting_orders, prep_time_minutes)
  on public.tenants to authenticated;

drop policy if exists tenants_owner_manage_operating_settings on public.tenants;
create policy tenants_owner_manage_operating_settings on public.tenants
  for update to authenticated
  using (public.has_tenant_role(id, array['owner','manager']::public.member_role[]))
  with check (public.has_tenant_role(id, array['owner','manager']::public.member_role[]));

create or replace function public.is_store_accepting_orders(target_tenant uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tenant public.tenants%rowtype;
  v_local timestamp;
  v_date text;
  v_day text;
  v_schedule jsonb;
  v_interval jsonb;
  v_open time;
  v_close time;
begin
  select * into v_tenant from public.tenants where id = target_tenant and is_active = true;
  if not found or not v_tenant.accepting_orders then return false; end if;

  v_local := now() at time zone 'Asia/Taipei';
  v_date := to_char(v_local::date, 'YYYY-MM-DD');
  v_day := extract(dow from v_local)::integer::text;

  if v_tenant.special_hours ? v_date then
    v_schedule := v_tenant.special_hours -> v_date;
    if coalesce((v_schedule ->> 'closed')::boolean, false) then return false; end if;
    v_schedule := coalesce(v_schedule -> 'intervals', '[]'::jsonb);
  else
    v_schedule := coalesce(v_tenant.weekly_hours -> v_day, '[]'::jsonb);
  end if;

  if jsonb_typeof(v_schedule) <> 'array' then return false; end if;\n\n  for v_interval in select value from jsonb_array_elements(v_schedule)
  loop
    begin
      v_open := (v_interval ->> 'open')::time;
      v_close := (v_interval ->> 'close')::time;
      if v_close > v_open and (v_local::time >= v_open and v_local::time < v_close) then
        return true;
      end if;
    exception when others then
      continue;
    end;
  end loop;
  return false;
end;
$$;

revoke all on function public.is_store_accepting_orders(uuid) from public;
grant execute on function public.is_store_accepting_orders(uuid) to anon, authenticated;

create or replace function public.create_public_order(
  p_tenant_slug text,
  p_customer_name text,
  p_customer_phone text,
  p_fulfillment public.fulfillment_type,
  p_table_label text,
  p_note text,
  p_items jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
  v_order_id uuid;
  v_order_number bigint;
  v_subtotal integer;
  v_line_count integer;
  v_distinct_count integer;
begin
  if p_tenant_slug is null or length(p_tenant_slug) not between 3 and 50 then
    raise exception 'invalid_store' using errcode = '22023';
  end if;
  if p_customer_name is null or length(btrim(p_customer_name)) not between 1 and 60 then
    raise exception 'invalid_customer_name' using errcode = '22023';
  end if;
  if p_customer_phone is null or length(regexp_replace(p_customer_phone, '[^0-9]', '', 'g')) not between 8 and 15 then
    raise exception 'invalid_customer_phone' using errcode = '22023';
  end if;
  if p_fulfillment = 'dine_in' and (p_table_label is null or length(btrim(p_table_label)) not between 1 and 20) then
    raise exception 'table_required' using errcode = '22023';
  end if;
  if p_fulfillment = 'takeaway' then p_table_label := null; end if;
  if p_note is not null and length(p_note) > 500 then
    raise exception 'note_too_long' using errcode = '22023';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) < 1 or jsonb_array_length(p_items) > 30 then
    raise exception 'invalid_order_items' using errcode = '22023';
  end if;

  select t.id into v_tenant_id from public.tenants t
  where t.slug = p_tenant_slug and t.is_active = true;
  if v_tenant_id is null then raise exception 'store_unavailable' using errcode = 'P0002'; end if;
  if not public.is_store_accepting_orders(v_tenant_id) then
    raise exception 'store_closed' using errcode = 'P0001';
  end if;

  select count(*), count(distinct p.id), coalesce(sum(p.price * x.quantity), 0)::integer
    into v_line_count, v_distinct_count, v_subtotal
  from jsonb_to_recordset(p_items) as x(product_name text, category_name text, quantity integer)
  join public.categories c on c.tenant_id = v_tenant_id and c.name = x.category_name and c.is_active = true
  join public.products p on p.tenant_id = v_tenant_id and p.category_id = c.id and p.name = x.product_name and p.is_available = true
  where x.quantity between 1 and 99;
  if v_line_count <> jsonb_array_length(p_items) or v_distinct_count <> v_line_count then
    raise exception 'item_unavailable_or_invalid' using errcode = '22023';
  end if;

  insert into public.orders(tenant_id, customer_name, customer_phone, fulfillment, table_label, note, subtotal, total)
  values (v_tenant_id, btrim(p_customer_name), regexp_replace(p_customer_phone, '[^0-9]', '', 'g'),
    p_fulfillment, p_table_label, coalesce(p_note, ''), v_subtotal, v_subtotal)
  returning id, order_number into v_order_id, v_order_number;

  insert into public.order_items(order_id, tenant_id, product_id, product_name, unit_price, quantity, line_total)
  select v_order_id, v_tenant_id, p.id, p.name, p.price, x.quantity, p.price * x.quantity
  from jsonb_to_recordset(p_items) as x(product_name text, category_name text, quantity integer)
  join public.categories c on c.tenant_id = v_tenant_id and c.name = x.category_name and c.is_active = true
  join public.products p on p.tenant_id = v_tenant_id and p.category_id = c.id and p.name = x.product_name and p.is_available = true;

  return jsonb_build_object('id', v_order_id, 'order_number', v_order_number,
    'subtotal', v_subtotal, 'total', v_subtotal, 'currency', 'TWD', 'status', 'pending');
end;
$$;

revoke all on function public.create_public_order(text,text,text,public.fulfillment_type,text,text,jsonb) from public;
grant execute on function public.create_public_order(text,text,text,public.fulfillment_type,text,text,jsonb) to anon, authenticated;
