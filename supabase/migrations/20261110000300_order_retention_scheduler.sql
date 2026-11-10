-- Scheduled maintenance entry point. Each tenant cleanup remains bounded to 500 stale
-- rows per table per invocation; checkout-triggered cleanup continues to work independently.
create or replace function public.cleanup_all_public_order_retention()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
  v_result jsonb;
  v_tenants_processed integer := 0;
  v_tenants_failed integer := 0;
  v_ip_deleted integer := 0;
  v_phone_deleted integer := 0;
  v_idempotency_deleted integer := 0;
begin
  for v_tenant_id in
    select t.id from public.tenants t order by t.id
  loop
    begin
      v_result := public.cleanup_public_order_retention(v_tenant_id);
      v_tenants_processed := v_tenants_processed + 1;
      v_ip_deleted := v_ip_deleted + coalesce((v_result ->> 'ip_limit_rows_deleted')::integer, 0);
      v_phone_deleted := v_phone_deleted + coalesce((v_result ->> 'phone_limit_rows_deleted')::integer, 0);
      v_idempotency_deleted := v_idempotency_deleted + coalesce((v_result ->> 'idempotency_rows_deleted')::integer, 0);
    exception when others then
      -- Isolate one tenant's cleanup failure so other tenants are still processed.
      v_tenants_failed := v_tenants_failed + 1;
      raise warning 'order_retention_cleanup_failed for tenant % with SQLSTATE %', v_tenant_id, sqlstate;
    end;
  end loop;

  return jsonb_build_object(
    'tenants_processed', v_tenants_processed,
    'tenants_failed', v_tenants_failed,
    'ip_limit_rows_deleted', v_ip_deleted,
    'phone_limit_rows_deleted', v_phone_deleted,
    'idempotency_rows_deleted', v_idempotency_deleted
  );
end;
$$;

revoke all on function public.cleanup_all_public_order_retention() from public, anon, authenticated;
grant execute on function public.cleanup_all_public_order_retention() to service_role;

comment on function public.cleanup_all_public_order_retention() is
  'Scheduled daily cleanup of stale checkout abuse-prevention and idempotency rows for every tenant. Does not delete orders, order items, customer contact data, or tracking links.';
