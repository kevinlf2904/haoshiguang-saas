-- Run after 20261111000100_pilot_owner_and_membership_invites.sql on disposable Supabase.
\set ON_ERROR_STOP on

do $$
declare
  v_tenant uuid;
  v_other_tenant uuid;
  v_user uuid := '70000000-0000-4000-8000-000000000001';
  v_second_user uuid := '70000000-0000-4000-8000-000000000002';
  v_staff_user uuid := '70000000-0000-4000-8000-000000000003';
  v_staff_membership uuid;
  v_owner_membership uuid;
  v_replay_rejected boolean := false;
  v_owner_removal_rejected boolean := false;
begin
  select id into v_tenant from public.tenants where slug = 'laozhang';
  if v_tenant is null then raise exception 'Pilot seed tenant is missing'; end if;

  insert into public.tenants(name,slug,currency)
  values ('Bootstrap isolation tenant','bootstrap-isolation','TWD')
  on conflict (slug) do update set name = excluded.name;
  select id into v_other_tenant from public.tenants where slug = 'bootstrap-isolation';

  insert into auth.users(id) values (v_user), (v_second_user), (v_staff_user)
  on conflict (id) do nothing;

  if has_function_privilege('anon','public.bootstrap_pilot_owner(uuid,uuid)','EXECUTE')
     or has_function_privilege('authenticated','public.bootstrap_pilot_owner(uuid,uuid)','EXECUTE')
     or has_function_privilege('anon','public.remove_tenant_member(uuid,uuid)','EXECUTE')
     or has_function_privilege('authenticated','public.remove_tenant_member(uuid,uuid)','EXECUTE') then
    raise exception 'Bootstrap and membership revocation RPCs must not be executable by browser roles';
  end if;
  if has_table_privilege('anon','public.pilot_owner_bootstrap_state','SELECT')
     or has_table_privilege('authenticated','public.pilot_owner_bootstrap_state','SELECT')
     or has_table_privilege('authenticated','public.pilot_owner_bootstrap_state','UPDATE') then
    raise exception 'Bootstrap state must be private to trusted server execution';
  end if;

  if has_table_privilege('anon','public.tenant_membership_invites','SELECT')
     or has_table_privilege('authenticated','public.tenant_membership_invites','SELECT')
     or has_table_privilege('authenticated','public.tenant_membership_invites','INSERT')
     or has_table_privilege('authenticated','public.tenant_membership_invites','UPDATE')
     or has_table_privilege('authenticated','public.tenant_membership_invites','DELETE') then
    raise exception 'Membership invite records must be inaccessible to browser roles';
  end if;
  if has_table_privilege('authenticated','public.memberships','INSERT')
     or has_table_privilege('authenticated','public.memberships','UPDATE')
     or has_table_privilege('authenticated','public.memberships','DELETE') then
    raise exception 'Browser roles must not mutate tenant memberships directly';
  end if;

  perform set_config('request.jwt.claim.role','service_role',true);
  perform public.bootstrap_pilot_owner(v_tenant,v_user);

  if not exists (
    select 1 from public.memberships
    where tenant_id = v_tenant and user_id = v_user and role = 'owner'
  ) then raise exception 'Bootstrap did not create the first owner membership'; end if;

  if not exists (
    select 1 from public.pilot_owner_bootstrap_state
    where singleton = true and tenant_id = v_tenant and completed_at is not null
  ) then raise exception 'Bootstrap claim was not persisted'; end if;

  begin
    perform public.bootstrap_pilot_owner(v_other_tenant,v_second_user);
  exception when sqlstate '55000' then
    v_replay_rejected := true;
  end;
  if not v_replay_rejected then raise exception 'Bootstrap replay must be rejected'; end if;

  if exists (
    select 1 from public.memberships
    where tenant_id = v_other_tenant and user_id = v_second_user
  ) then raise exception 'Replay created a cross-tenant owner membership'; end if;

  insert into public.memberships(tenant_id,user_id,role)
  values (v_tenant,v_staff_user,'staff') returning id into v_staff_membership;
  insert into public.tenant_membership_invites(tenant_id,normalized_email,user_id,role,invited_by)
  values (v_tenant,'staff-bootstrap-test@example.test',v_staff_user,'staff',v_user);
  perform public.remove_tenant_member(v_tenant,v_staff_membership);
  if exists (select 1 from public.memberships where id = v_staff_membership)
     or exists (select 1 from public.tenant_membership_invites where tenant_id = v_tenant and user_id = v_staff_user) then
    raise exception 'Atomic member removal must delete membership and invite record';
  end if;

  select id into v_owner_membership from public.memberships
  where tenant_id = v_tenant and user_id = v_user and role = 'owner';
  begin
    perform public.remove_tenant_member(v_tenant,v_owner_membership);
  exception when sqlstate '55000' then
    v_owner_removal_rejected := true;
  end;
  if not v_owner_removal_rejected then raise exception 'Owner membership removal must require a transfer flow'; end if;

  raise notice 'PASS: one-time bootstrap, replay protection, browser privilege boundaries, atomic member removal, owner protection';
end
$$;
