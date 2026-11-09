-- Retention for public checkout abuse-prevention and idempotency records.
-- Rate-limit rows are only consulted for a rolling 10-minute window; keep 24 hours
-- for operational diagnosis, then remove them in bounded batches.
-- Idempotency keys are replay-safe for 7 days. After expiry, the same key may
-- create a new order; clients should generate a fresh key for a new checkout.

create index public_order_ip_limits_retention_idx
  on public.public_order_ip_limits (tenant_id, created_at);
create index public_order_rate_limits_retention_idx
  on public.public_order_rate_limits (tenant_id, created_at);
create index public_order_idempotency_retention_idx
  on public.public_order_idempotency (tenant_id, created_at);

create or replace function public.cleanup_public_order_retention(p_tenant_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ip_deleted integer := 0;
  v_phone_deleted integer := 0;
  v_idempotency_deleted integer := 0;
begin
  if p_tenant_id is null then
    raise exception 'tenant_required' using errcode = '22023';
  end if;

  with stale as (
    select r.ctid from public.public_order_ip_limits r
    where r.tenant_id = p_tenant_id and r.created_at < now() - interval '24 hours'
    order by r.created_at limit 500
  )
  delete from public.public_order_ip_limits r using stale where r.ctid = stale.ctid;
  get diagnostics v_ip_deleted = row_count;

  with stale as (
    select r.ctid from public.public_order_rate_limits r
    where r.tenant_id = p_tenant_id and r.created_at < now() - interval '24 hours'
    order by r.created_at limit 500
  )
  delete from public.public_order_rate_limits r using stale where r.ctid = stale.ctid;
  get diagnostics v_phone_deleted = row_count;

  with stale as (
    select i.ctid from public.public_order_idempotency i
    where i.tenant_id = p_tenant_id and i.created_at < now() - interval '7 days'
    order by i.created_at limit 500
  )
  delete from public.public_order_idempotency i using stale where i.ctid = stale.ctid;
  get diagnostics v_idempotency_deleted = row_count;

  return jsonb_build_object(
    'ip_limit_rows_deleted', v_ip_deleted,
    'phone_limit_rows_deleted', v_phone_deleted,
    'idempotency_rows_deleted', v_idempotency_deleted
  );
end;
$$;

revoke all on function public.cleanup_public_order_retention(uuid) from public, anon, authenticated;
grant execute on function public.cleanup_public_order_retention(uuid) to service_role;

comment on function public.cleanup_public_order_retention(uuid) is
  'Deletes up to 500 stale rows per table for one tenant. Rate-limit retention: 24h; idempotency replay retention: 7 days. Invoked transactionally by create_public_order; service_role may also invoke it for maintenance.';

-- Run cleanup only after a new order has been committed to the idempotency ledger.
-- The trigger executes in the same transaction as checkout, so a cleanup failure
-- rolls back the order rather than silently skipping retention maintenance.
create or replace function public.trigger_checkout_retention_cleanup()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.cleanup_public_order_retention(new.tenant_id);
  return new;
end;
$$;

revoke all on function public.trigger_checkout_retention_cleanup() from public, anon, authenticated;

create trigger public_order_idempotency_retention_cleanup
after insert on public.public_order_idempotency
for each row execute function public.trigger_checkout_retention_cleanup();
