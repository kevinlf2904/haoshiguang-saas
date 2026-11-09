-- Per-tenant operating schedule and order-acceptance controls.
create table public.store_settings (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,
  is_accepting_orders boolean not null default true,
  prep_time_minutes integer not null default 20 check (prep_time_minutes between 5 and 180),
  weekly_hours jsonb not null default '{}'::jsonb check (jsonb_typeof(weekly_hours) = 'object'),
  closed_dates date[] not null default '{}',
  updated_at timestamptz not null default now()
);

alter table public.store_settings enable row level security;

create policy store_settings_public_read on public.store_settings
  for select using (exists (
    select 1 from public.tenants t where t.id = tenant_id and t.is_active = true
  ));

create policy store_settings_member_read on public.store_settings
  for select using (public.is_tenant_member(tenant_id));

create policy store_settings_manager_write on public.store_settings
  for all
  using (public.has_tenant_role(tenant_id, array['owner','manager']::public.member_role[]))
  with check (public.has_tenant_role(tenant_id, array['owner','manager']::public.member_role[]));

grant select on public.store_settings to anon, authenticated;
grant insert, update on public.store_settings to authenticated;

-- Existing pilot tenants remain orderable until an owner explicitly configures hours.
insert into public.store_settings (tenant_id)
select id from public.tenants
on conflict (tenant_id) do nothing;

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
  v_settings public.store_settings%rowtype;
  v_local_now timestamp;
  v_day_key text;
  v_slots jsonb;
  v_is_open boolean := true;
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

  select t.id into v_tenant_id
  from public.tenants t
  where t.slug = p_tenant_slug and t.is_active = true;
  if v_tenant_id is null then
    raise exception 'store_unavailable' using errcode = 'P0002';
  end if;

  select * into v_settings from public.store_settings where tenant_id = v_tenant_id;
  if found then
    if not v_settings.is_accepting_orders then
      raise exception 'store_unavailable' using errcode = 'P0002';
    end if;
    v_local_now := now() at time zone 'Asia/Taipei';
    if v_local_now::date = any(v_settings.closed_dates) then
      raise exception 'store_closed' using errcode = 'P0002';
    end if;
    if v_settings.weekly_hours <> '{}'::jsonb then
      v_day_key := case extract(isodow from v_local_now)::integer
        when 1 then 'mon' when 2 then 'tue' when 3 then 'wed'
        when 4 then 'thu' when 5 then 'fri' when 6 then 'sat'
        else 'sun' end;
      v_slots := coalesce(v_settings.weekly_hours -> v_day_key, '[]'::jsonb);
      select exists (
        select 1
        from jsonb_array_elements(v_slots) slot
        where (v_local_now::time >= (slot ->> 'open')::time)
          and (v_local_now::time < (slot ->> 'close')::time)
      ) into v_is_open;
      if not v_is_open then
        raise exception 'store_closed' using errcode = 'P0002';
      end if;
    end if;
  end if;

  select count(*), count(distinct p.id), coalesce(sum(p.price * x.quantity), 0)::integer
    into v_line_count, v_distinct_count, v_subtotal
  from jsonb_to_recordset(p_items) as x(product_name text, category_name text, quantity integer)
  join public.categories c on c.tenant_id = v_tenant_id
       and c.name = x.category_name and c.is_active = true
  join public.products p on p.tenant_id = v_tenant_id
       and p.category_id = c.id and p.name = x.product_name and p.is_available = true
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
  join public.products p on p.tenant_id = v_tenant_id and p.category_id = c.id
    and p.name = x.product_name and p.is_available = true;

  return jsonb_build_object('id', v_order_id, 'order_number', v_order_number,
    'subtotal', v_subtotal, 'total', v_subtotal, 'currency', 'TWD', 'status', 'pending');
end;
$$;

revoke all on function public.create_public_order(text,text,text,public.fulfillment_type,text,text,jsonb) from public;
grant execute on function public.create_public_order(text,text,text,public.fulfillment_type,text,text,jsonb) to anon, authenticated;

create or replace function public.is_valid_weekly_hours(p_hours jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_day text;
  v_slots jsonb;
  v_slot jsonb;
  v_open text;
  v_close text;
  v_previous_close text;
begin
  if jsonb_typeof(p_hours) <> 'object' then return false; end if;
  for v_day, v_slots in select key, value from jsonb_each(p_hours) loop
    if v_day not in ('mon','tue','wed','thu','fri','sat','sun')
       or jsonb_typeof(v_slots) <> 'array'
       or jsonb_array_length(v_slots) > 2 then return false; end if;
    v_previous_close := null;
    for v_slot in select value from jsonb_array_elements(v_slots) loop
      if jsonb_typeof(v_slot) <> 'object' then return false; end if;
      v_open := v_slot ->> 'open';
      v_close := v_slot ->> 'close';
      if v_open is null or v_close is null
         or v_open !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
         or v_close !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
         or v_open >= v_close
         or (v_previous_close is not null and v_open < v_previous_close) then
        return false;
      end if;
      v_previous_close := v_close;
    end loop;
  end loop;
  return true;
exception when others then
  return false;
end;
$$;

alter table public.store_settings
  add constraint store_settings_weekly_hours_valid check (public.is_valid_weekly_hours(weekly_hours)),
  add constraint store_settings_closed_dates_limit check (cardinality(closed_dates) <= 90);
