-- Store profile permissions: only a tenant's owner/manager may update name, phone and address.
\set ON_ERROR_STOP on

do $$
begin
  if has_column_privilege('authenticated','public.tenants','name','UPDATE') is not true
     or has_column_privilege('authenticated','public.tenants','phone','UPDATE') is not true
     or has_column_privilege('authenticated','public.tenants','address','UPDATE') is not true then
    raise exception 'authenticated role must have column-scoped profile update grants';
  end if;
  if has_column_privilege('authenticated','public.tenants','slug','UPDATE')
     or has_column_privilege('authenticated','public.tenants','is_active','UPDATE') then
    raise exception 'authenticated role must not update tenant slug or active status';
  end if;
  if has_table_privilege('anon','public.tenants','UPDATE') then
    raise exception 'anon must not update tenant profiles';
  end if;
end $$;

set role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000001',false);
do $$
declare affected integer;
begin
  update public.tenants set name='店家 A 名稱更新', phone='0223456789', address='台北市測試路 1 號'
  where id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  get diagnostics affected = row_count;
  if affected <> 1 then raise exception 'owner must update own store profile'; end if;

  update public.tenants set name='跨店非法修改'
  where id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  get diagnostics affected = row_count;
  if affected <> 0 then raise exception 'owner must not update another tenant profile'; end if;
end $$;

select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000002',false);
do $$
declare affected integer;
begin
  update public.tenants set name='店家 A 管理者更新'
  where id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  get diagnostics affected = row_count;
  if affected <> 1 then raise exception 'manager must update own store profile'; end if;
end $$;

select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000003',false);
do $$
declare affected integer;
begin
  update public.tenants set name='員工非法修改'
  where id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  get diagnostics affected = row_count;
  if affected <> 0 then raise exception 'staff must not update store profile'; end if;
end $$;
reset role;
