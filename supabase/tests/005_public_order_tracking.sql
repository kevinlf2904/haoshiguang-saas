do $$
begin
  if to_regclass('public.public_order_tracking') is null then
    raise exception 'public_order_tracking table is missing';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.public_order_tracking'::regclass) then
    raise exception 'public_order_tracking must have RLS enabled';
  end if;
  if has_table_privilege('anon', 'public.public_order_tracking', 'SELECT')
     or has_table_privilege('authenticated', 'public.public_order_tracking', 'SELECT') then
    raise exception 'public client roles must not read tracking token hashes';
  end if;
  if not has_table_privilege('service_role', 'public.public_order_tracking', 'SELECT')
     or not has_table_privilege('service_role', 'public.public_order_tracking', 'INSERT')
     or not has_table_privilege('service_role', 'public.public_order_tracking', 'UPDATE') then
    raise exception 'service_role requires controlled tracking table access';
  end if;
end
$$;

-- Token hashes are unique and fixed-format; raw bearer tokens are never stored.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.public_order_tracking'::regclass
      and contype = 'u'
  ) then
    raise exception 'tracking token hash uniqueness constraint is missing';
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.public_order_tracking'::regclass
      and contype = 'c'
  ) then
    raise exception 'tracking token hash format constraint is missing';
  end if;
end
$$;


-- Each tracking digest is bound to the key version used at issuance.
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'public_order_tracking'
      and column_name = 'key_version'
      and data_type = 'integer'
      and is_nullable = 'NO'
  ) then
    raise exception 'tracking key_version column is missing or nullable';
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.public_order_tracking'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%key_version%'
  ) then
    raise exception 'tracking key_version positive constraint is missing';
  end if;
end
$$;
