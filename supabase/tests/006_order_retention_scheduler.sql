begin;

do $$
declare
  v_tenant uuid;
  v_summary jsonb;
begin
  select id into v_tenant from public.tenants where slug = 'laozhang';
  if v_tenant is null then raise exception 'pilot_tenant_missing'; end if;

  if has_function_privilege('anon', 'public.cleanup_all_public_order_retention()', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.cleanup_all_public_order_retention()', 'EXECUTE') then
    raise exception 'public_roles_must_not_execute_scheduled_retention';
  end if;
  if not has_function_privilege('service_role', 'public.cleanup_all_public_order_retention()', 'EXECUTE') then
    raise exception 'service_role_must_execute_scheduled_retention';
  end if;

  insert into public.public_order_ip_limits(tenant_id, ip_hash, created_at)
  values (v_tenant, repeat('9', 64), now() - interval '25 hours');

  v_summary := public.cleanup_all_public_order_retention();
  if coalesce((v_summary ->> 'tenants_processed')::integer, 0) < 1 then
    raise exception 'scheduled_cleanup_did_not_process_tenants';
  end if;
  if coalesce((v_summary ->> 'tenants_failed')::integer, 0) <> 0 then
    raise exception 'scheduled_cleanup_reported_tenant_failures';
  end if;
  if exists (
    select 1 from public.public_order_ip_limits
    where tenant_id = v_tenant and ip_hash = repeat('9', 64)
  ) then
    raise exception 'scheduled_cleanup_did_not_remove_stale_ip_limit';
  end if;
end
$$;

rollback;
