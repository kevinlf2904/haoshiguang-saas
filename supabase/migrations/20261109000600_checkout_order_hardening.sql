-- Checkout and order-state hardening. Applies only when this stacked PR is merged.
-- Rate-limit successful orders per tenant + normalized phone; no client-supplied IP is trusted.
create table public.public_order_rate_limits (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  phone_hash text not null,
  created_at timestamptz not null default now()
);
create index public_order_rate_limits_lookup_idx
  on public.public_order_rate_limits (tenant_id, phone_hash, created_at desc);
alter table public.public_order_rate_limits enable row level security;
revoke all on public.public_order_rate_limits from anon, authenticated;

create or replace function public.enforce_order_status_transition()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status = old.status then return new; end if;
  if not (
    (old.status = 'pending' and new.status in ('accepted','cancelled')) or
    (old.status = 'accepted' and new.status in ('preparing','cancelled')) or
    (old.status = 'preparing' and new.status in ('ready','cancelled')) or
    (old.status = 'ready' and new.status = 'completed')
  ) then
    raise exception 'invalid_order_status_transition' using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists orders_status_transition_guard on public.orders;
create trigger orders_status_transition_guard
before update of status on public.orders
for each row execute function public.enforce_order_status_transition();

-- Revoke direct status writes from anon and authenticated clients. Merchant API
-- updates remain governed by the existing tenant-membership RLS policy.
-- The existing authenticated UPDATE grant remains; the trigger is the database-enforced guard.

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
  v_subtotal numeric;
  v_line_count integer;
  v_distinct_count integer;
  v_phone text;
  v_phone_hash text;
  v_item jsonb;
begin
  if p_tenant_slug is null or length(p_tenant_slug) not between 3 and 50 then
    raise exception 'invalid_store' using errcode = '22023';
  end if;
  if p_customer_name is null or length(btrim(p_customer_name)) not between 1 and 60 then
    raise exception 'invalid_customer_name' using errcode = '22023';
  end if;
  v_phone := regexp_replace(coalesce(p_customer_phone,''), '[^0-9]', '', 'g');
  if length(v_phone) not between 8 and 15 then
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
  from public.tenants t where t.slug = p_tenant_slug and t.is_active = true;
  if v_tenant_id is null then
    raise exception 'store_unavailable' using errcode = 'P0002';
  end if;

  -- Lock all referenced active catalog rows before pricing and snapshot insertion.
  -- Concurrent price edits or sell-outs wait until this transaction completes.
  for v_item in select value from jsonb_array_elements(p_items) loop
    if coalesce(v_item ->> 'quantity','') !~ '^[0-9]+$'
       or (v_item ->> 'quantity')::integer not between 1 and 99 then
      raise exception 'item_unavailable_or_invalid' using errcode = '22023';
    end if;
    perform 1
    from public.categories c
    join public.products p on p.category_id = c.id and p.tenant_id = c.tenant_id
    where c.tenant_id = v_tenant_id
      and c.name = v_item ->> 'category_name' and c.is_active = true
      and p.name = v_item ->> 'product_name' and p.is_available = true
    for share of c, p;
  end loop;

  select count(*), count(distinct p.id),
         coalesce(sum(p.price::numeric * x.quantity), 0)
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
  -- orders.total/subtotal are PostgreSQL integer columns. Reject overflow explicitly.
  if v_subtotal > 2000000000 then
    raise exception 'order_total_exceeds_limit' using errcode = '22023';
  end if;

  -- Serialize attempts for this store + normalized phone, then allow at most
  -- five successful checkouts in a rolling ten-minute window.
  v_phone_hash := md5(v_phone);
  perform pg_advisory_xact_lock(hashtextextended(v_tenant_id::text || ':' || v_phone_hash, 0));
  if (select count(*) from public.public_order_rate_limits r
      where r.tenant_id = v_tenant_id and r.phone_hash = v_phone_hash
        and r.created_at > now() - interval '10 minutes') >= 5 then
    raise exception 'order_rate_limited' using errcode = 'P0001';
  end if;
  insert into public.public_order_rate_limits(tenant_id, phone_hash)
  values (v_tenant_id, v_phone_hash);

  insert into public.orders(tenant_id, customer_name, customer_phone, fulfillment, table_label, note, subtotal, total)
  values (v_tenant_id, btrim(p_customer_name), v_phone, p_fulfillment, p_table_label,
    coalesce(p_note, ''), v_subtotal::integer, v_subtotal::integer)
  returning id, order_number into v_order_id, v_order_number;

  insert into public.order_items(order_id, tenant_id, product_id, product_name, unit_price, quantity, line_total)
  select v_order_id, v_tenant_id, p.id, p.name, p.price, x.quantity, p.price * x.quantity
  from jsonb_to_recordset(p_items) as x(product_name text, category_name text, quantity integer)
  join public.categories c on c.tenant_id = v_tenant_id and c.name = x.category_name and c.is_active = true
  join public.products p on p.tenant_id = v_tenant_id and p.category_id = c.id
    and p.name = x.product_name and p.is_available = true;

  return jsonb_build_object('id', v_order_id, 'order_number', v_order_number,
    'subtotal', v_subtotal::integer, 'total', v_subtotal::integer,
    'currency', 'TWD', 'status', 'pending');
end;
$$;

revoke all on function public.create_public_order(text,text,text,public.fulfillment_type,text,text,jsonb) from public;
grant execute on function public.create_public_order(text,text,text,public.fulfillment_type,text,text,jsonb) to anon, authenticated;
