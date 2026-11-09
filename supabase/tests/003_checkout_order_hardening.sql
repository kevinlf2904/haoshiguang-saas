begin;

do $$
declare
  v_tenant uuid;
  v_order uuid;
  v_count integer;
  v_rejected boolean := false;
  v_first jsonb;
  v_second jsonb;
  i integer;
begin
  select id into v_tenant from public.tenants where slug = 'laozhang';
  if v_tenant is null then raise exception 'pilot_tenant_missing'; end if;

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
      ('22222222-2222-4222-8222-' || lpad(i::text,12,'0'))::uuid, repeat('b',32)
    );
  end loop;

  begin
    perform public.create_public_order(
      'laozhang', '限流測試', '0987654321', 'takeaway', null, '',
      '[{"product_name":"白飯","category_name":"飯類","quantity":1}]'::jsonb,
      '33333333-3333-4333-8333-333333333333'::uuid, repeat('c',32)
    );
  exception when sqlstate 'P0001' then
    v_rejected := true;
  end;
  if not v_rejected then raise exception 'rate_limit_was_not_enforced'; end if;

  -- Reusing one idempotency key returns the same order instead of inserting twice.
  v_first := public.create_public_order(
    'laozhang', '冪等測試', '0911111111', 'takeaway', null, '',
    '[{"product_name":"白飯","category_name":"飯類","quantity":1}]'::jsonb,
    '11111111-1111-4111-8111-111111111111'::uuid, repeat('a',32)
  );
  v_second := public.create_public_order(
    'laozhang', '冪等測試', '0911111111', 'takeaway', null, '',
    '[{"product_name":"白飯","category_name":"飯類","quantity":1}]'::jsonb,
    '11111111-1111-4111-8111-111111111111'::uuid, repeat('a',32)
  );
  if v_first ->> 'id' <> v_second ->> 'id' then
    raise exception 'idempotency_did_not_return_original_order';
  end if;
end;
$$;

rollback;
