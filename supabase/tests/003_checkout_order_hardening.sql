begin;

do $$
declare
  v_tenant uuid;
  v_order uuid;
  v_count integer;
  v_rejected boolean := false;
  v_ip_rejected boolean := false;
  v_first jsonb;
  v_second jsonb;
  i integer;
begin
  select id into v_tenant from public.tenants where slug = 'laozhang';
  if v_tenant is null then raise exception 'pilot_tenant_missing'; end if;

  if has_function_privilege('anon',
    'public.create_public_order(text,text,text,public.fulfillment_type,text,text,jsonb,uuid,text,text,text)', 'EXECUTE') then
    raise exception 'anon_must_not_execute_checkout_rpc';
  end if;
  if has_function_privilege('authenticated',
    'public.create_public_order(text,text,text,public.fulfillment_type,text,text,jsonb,uuid,text,text,text)', 'EXECUTE') then
    raise exception 'authenticated_must_not_execute_checkout_rpc';
  end if;
  if not has_function_privilege('service_role',
    'public.create_public_order(text,text,text,public.fulfillment_type,text,text,jsonb,uuid,text,text,text)', 'EXECUTE') then
    raise exception 'service_role_must_execute_checkout_rpc';
  end if;

  insert into public.orders(tenant_id, customer_name, customer_phone, fulfillment, subtotal, total)
  values (v_tenant, '狀態轉換測試', '0912345678', 'takeaway', 20, 20)
  returning id into v_order;

  begin
    update public.orders set status = 'ready' where id = v_order;
    raise exception 'invalid_transition_was_allowed';
  exception when check_violation then
    null;
  end;

  update public.orders set status = 'accepted' where id = v_order;
  if (select status from public.orders where id = v_order) <> 'accepted' then
    raise exception 'valid_transition_failed';
  end if;

  -- Five successful checkouts per store/phone are allowed in a rolling 10-minute
  -- window; the sixth must be rejected by the database, even when RPC is called directly.
  for i in 1..5 loop
    perform public.create_public_order(
      'laozhang', '限流測試', '0987654321', 'takeaway', null, '',
      '[{"product_name":"白飯","category_name":"飯類","quantity":1}]'::jsonb,
      ('22222222-2222-4222-8222-' || lpad(i::text,12,'0'))::uuid, repeat('b',64), repeat('f',64), repeat('1',64)
    );
  end loop;

  begin
    perform public.create_public_order(
      'laozhang', '限流測試', '0987654321', 'takeaway', null, '',
      '[{"product_name":"白飯","category_name":"飯類","quantity":1}]'::jsonb,
      '33333333-3333-4333-8333-333333333333'::uuid, repeat('c',64), repeat('f',64), repeat('2',64)
    );
  exception when sqlstate 'P0001' then
    v_rejected := true;
  end;
  if not v_rejected then raise exception 'rate_limit_was_not_enforced'; end if;

  -- Reusing one idempotency key returns the same order instead of inserting twice.
  v_first := public.create_public_order(
    'laozhang', '冪等測試', '0911111111', 'takeaway', null, '',
    '[{"product_name":"白飯","category_name":"飯類","quantity":1}]'::jsonb,
    '11111111-1111-4111-8111-111111111111'::uuid, repeat('a',64), repeat('d',64), repeat('a',64)
  );
  v_second := public.create_public_order(
    'laozhang', '冪等測試', '0911111111', 'takeaway', null, '',
    '[{"product_name":"白飯","category_name":"飯類","quantity":1}]'::jsonb,
    '11111111-1111-4111-8111-111111111111'::uuid, repeat('a',64), repeat('d',64), repeat('a',64)
  );
  if v_first ->> 'id' <> v_second ->> 'id' then
    raise exception 'idempotency_did_not_return_original_order';
  end if;

  begin
    perform public.create_public_order(
      'laozhang', '冪等測試', '0911111111', 'takeaway', null, '',
      '[{"product_name":"牛肉麵","category_name":"麵類","quantity":1}]'::jsonb,
      '11111111-1111-4111-8111-111111111111'::uuid, repeat('a',64), repeat('d',64), repeat('b',64)
    );
    raise exception 'idempotency_payload_mismatch_was_allowed';
  exception when sqlstate '22023' then
    null;
  end;

  -- Twenty successful orders from one source IP are allowed; the 21st is blocked.
  for i in 1..20 loop
    perform public.create_public_order(
      'laozhang', 'IP限流測試', ('09' || lpad(i::text,8,'0')), 'takeaway', null, '',
      '[{"product_name":"白飯","category_name":"飯類","quantity":1}]'::jsonb,
      ('55555555-5555-4555-8555-' || lpad(i::text,12,'0'))::uuid, repeat('e',64), lpad(i::text,64,'e'), repeat('e',64)
    );
  end loop;
  begin
    perform public.create_public_order(
      'laozhang', 'IP限流測試', '0999999999', 'takeaway', null, '',
      '[{"product_name":"白飯","category_name":"飯類","quantity":1}]'::jsonb,
      '66666666-6666-4666-8666-666666666666'::uuid, repeat('e',64), repeat('e',62) || '20', repeat('e',64)
    );
  exception when sqlstate 'P0001' then
    v_ip_rejected := true;
  end;
  if not v_ip_rejected then raise exception 'ip_rate_limit_was_not_enforced'; end if;

  -- Retention removes stale rows and preserves records inside the retention windows.
  if has_function_privilege('anon', 'public.cleanup_public_order_retention(uuid)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.cleanup_public_order_retention(uuid)', 'EXECUTE') then
    raise exception 'public_roles_must_not_execute_retention_cleanup';
  end if;
  if not has_function_privilege('service_role', 'public.cleanup_public_order_retention(uuid)', 'EXECUTE') then
    raise exception 'service_role_must_execute_retention_cleanup';
  end if;

  insert into public.orders(tenant_id, customer_name, customer_phone, fulfillment, subtotal, total)
  values (v_tenant, '保留期限測試', '0910000000', 'takeaway', 20, 20)
  returning id into v_order;

  insert into public.public_order_ip_limits(tenant_id, ip_hash, created_at) values
    (v_tenant, repeat('1',64), now() - interval '25 hours'),
    (v_tenant, repeat('2',64), now() - interval '5 minutes');
  insert into public.public_order_rate_limits(tenant_id, phone_hash, created_at) values
    (v_tenant, repeat('3',64), now() - interval '25 hours'),
    (v_tenant, repeat('4',64), now() - interval '5 minutes');
  insert into public.public_order_idempotency(tenant_id, idempotency_key, request_hash, order_id, created_at) values
    (v_tenant, '77777777-7777-4777-8777-777777777771', repeat('7',64), v_order, now()),
    (v_tenant, '77777777-7777-4777-8777-777777777772', repeat('7',64), v_order, now());
  update public.public_order_idempotency
  set created_at = now() - interval '8 days'
  where tenant_id = v_tenant
    and idempotency_key = '77777777-7777-4777-8777-777777777771';

  perform public.cleanup_public_order_retention(v_tenant);

  if exists (select 1 from public.public_order_ip_limits where tenant_id=v_tenant and ip_hash=repeat('1',64)) then
    raise exception 'stale_ip_limit_row_was_not_deleted';
  end if;
  if not exists (select 1 from public.public_order_ip_limits where tenant_id=v_tenant and ip_hash=repeat('2',64)) then
    raise exception 'recent_ip_limit_row_was_deleted';
  end if;
  if exists (select 1 from public.public_order_rate_limits where tenant_id=v_tenant and phone_hash=repeat('3',64)) then
    raise exception 'stale_phone_limit_row_was_not_deleted';
  end if;
  if not exists (select 1 from public.public_order_rate_limits where tenant_id=v_tenant and phone_hash=repeat('4',64)) then
    raise exception 'recent_phone_limit_row_was_deleted';
  end if;
  if exists (select 1 from public.public_order_idempotency
      where tenant_id=v_tenant and idempotency_key='77777777-7777-4777-8777-777777777771') then
    raise exception 'expired_idempotency_row_was_not_deleted';
  end if;
  if not exists (select 1 from public.public_order_idempotency
      where tenant_id=v_tenant and idempotency_key='77777777-7777-4777-8777-777777777772') then
    raise exception 'idempotency_row_inside_replay_window_was_deleted';
  end if;
end;
$$;

rollback;
