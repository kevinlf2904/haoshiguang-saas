-- One-time, explicitly configured first-owner bootstrap.
-- Tenant membership changes are performed through server-only service-role RPCs.
create table public.pilot_owner_bootstrap_state (
  singleton boolean primary key default true check (singleton),
  tenant_id uuid references public.tenants(id) on delete restrict,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  check ((completed_at is null and tenant_id is null) or
         (completed_at is not null and tenant_id is not null))
);

insert into public.pilot_owner_bootstrap_state(singleton)
values (true)
on conflict (singleton) do nothing;

-- Membership writes must go through the audited service-role RPCs below.
-- The application server only needs SELECT; no API route performs direct DML.
revoke insert, update, delete on public.memberships from public, anon, authenticated;

alter table public.pilot_owner_bootstrap_state enable row level security;
revoke all on public.pilot_owner_bootstrap_state from public, anon, authenticated, service_role;

create table public.tenant_membership_invites (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  normalized_email text not null check (normalized_email = lower(btrim(normalized_email)) and length(normalized_email) between 3 and 254),
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.member_role not null check (role in ('manager','staff')),
  invited_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (tenant_id, normalized_email),
  unique (tenant_id, user_id)
);

alter table public.tenant_membership_invites enable row level security;
revoke all on public.tenant_membership_invites from public, anon, authenticated;
grant select on public.tenant_membership_invites to service_role;
revoke insert, update, delete on public.tenant_membership_invites from service_role;

create or replace function public.bootstrap_pilot_owner(
  target_tenant_id uuid,
  target_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_claim public.pilot_owner_bootstrap_state%rowtype;
begin
  if coalesce(current_setting('request.jwt.claim.role', true), '') <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;

  select * into v_claim
  from public.pilot_owner_bootstrap_state
  where singleton = true
  for update;

  if not found or v_claim.completed_at is not null then
    raise exception 'pilot_owner_bootstrap_already_used' using errcode = '55000';
  end if;

  if not exists (
    select 1 from public.tenants
    where id = target_tenant_id and is_active = true
  ) then
    raise exception 'pilot_tenant_not_found' using errcode = 'P0002';
  end if;

  if not exists (select 1 from auth.users where id = target_user_id) then
    raise exception 'pilot_owner_auth_user_not_found' using errcode = 'P0002';
  end if;

  if exists (
    select 1 from public.memberships
    where tenant_id = target_tenant_id and role = 'owner'
  ) then
    raise exception 'pilot_tenant_already_has_owner' using errcode = '55000';
  end if;

  insert into public.memberships(tenant_id, user_id, role)
  values (target_tenant_id, target_user_id, 'owner');

  update public.pilot_owner_bootstrap_state
  set tenant_id = target_tenant_id, completed_at = now()
  where singleton = true;
end;
$$;

revoke all on function public.bootstrap_pilot_owner(uuid, uuid) from public, anon, authenticated;
grant execute on function public.bootstrap_pilot_owner(uuid, uuid) to service_role;

comment on function public.bootstrap_pilot_owner(uuid, uuid) is
  'One-time service-role-only assignment of the first owner to the configured Pilot tenant. The caller must independently validate a high-entropy bootstrap secret.';

create or replace function public.grant_tenant_member_invite(
  target_tenant_id uuid,
  target_user_id uuid,
  target_email text,
  target_role public.member_role,
  actor_user_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_role public.member_role;
  v_existing_invite public.tenant_membership_invites%rowtype;
  v_existing_member_role public.member_role;
  v_new_invite boolean := false;
begin
  if coalesce(current_setting('request.jwt.claim.role', true), '') <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;

  select role into v_actor_role
  from public.memberships
  where tenant_id = target_tenant_id and user_id = actor_user_id
  for share;

  if v_actor_role is null or v_actor_role not in ('owner','manager') then
    raise exception 'tenant_invite_forbidden' using errcode = '42501';
  end if;
  if target_role not in ('manager','staff') then
    raise exception 'invalid_invite_role' using errcode = '22023';
  end if;
  if v_actor_role = 'manager' and target_role <> 'staff' then
    raise exception 'manager_can_only_invite_staff' using errcode = '42501';
  end if;
  if target_email is null or target_email <> lower(btrim(target_email)) or
     length(target_email) not between 3 and 254 then
    raise exception 'invalid_invite_email' using errcode = '22023';
  end if;
  if not exists (select 1 from auth.users where id = target_user_id) then
    raise exception 'invite_auth_user_not_found' using errcode = 'P0002';
  end if;

  select * into v_existing_invite
  from public.tenant_membership_invites
  where tenant_id = target_tenant_id and normalized_email = target_email
  for update;

  if found then
    if v_existing_invite.user_id <> target_user_id or v_existing_invite.role <> target_role then
      raise exception 'invite_conflict' using errcode = '23505';
    end if;
  else
    if exists (
      select 1 from public.memberships
      where tenant_id = target_tenant_id and user_id = target_user_id
    ) then
      raise exception 'membership_already_exists_without_invite' using errcode = '23505';
    end if;
    insert into public.tenant_membership_invites(
      tenant_id, normalized_email, user_id, role, invited_by
    ) values (target_tenant_id, target_email, target_user_id, target_role, actor_user_id);
    v_new_invite := true;
  end if;

  select role into v_existing_member_role
  from public.memberships
  where tenant_id = target_tenant_id and user_id = target_user_id;

  if v_existing_member_role is not null and v_existing_member_role <> target_role then
    raise exception 'membership_role_conflict' using errcode = '23505';
  end if;
  if v_existing_member_role is null then
    insert into public.memberships(tenant_id,user_id,role)
    values (target_tenant_id,target_user_id,target_role);
  end if;

  return v_new_invite;
end;
$$;

revoke all on function public.grant_tenant_member_invite(uuid,uuid,text,public.member_role,uuid) from public, anon, authenticated;
grant execute on function public.grant_tenant_member_invite(uuid,uuid,text,public.member_role,uuid) to service_role;

comment on function public.grant_tenant_member_invite(uuid,uuid,text,public.member_role,uuid) is
  'Atomically validates the actor tenant role, records an invite, and grants a manager/staff membership. Idempotent for an existing matching invite.';

create or replace function public.remove_tenant_member(
  target_tenant_id uuid,
  target_membership_id uuid,
  actor_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_role public.member_role;
  v_user_id uuid;
  v_target_role public.member_role;
begin
  if coalesce(current_setting('request.jwt.claim.role', true), '') <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;

  select role into v_actor_role
  from public.memberships
  where tenant_id = target_tenant_id and user_id = actor_user_id
  for share;

  if v_actor_role is null or v_actor_role not in ('owner','manager') then
    raise exception 'tenant_member_removal_forbidden' using errcode = '42501';
  end if;

  select user_id, role into v_user_id, v_target_role
  from public.memberships
  where id = target_membership_id and tenant_id = target_tenant_id
  for update;

  if not found then
    raise exception 'tenant_membership_not_found' using errcode = 'P0002';
  end if;
  if v_target_role = 'owner' then
    raise exception 'owner_membership_transfer_required' using errcode = '55000';
  end if;
  if v_actor_role = 'manager' and v_target_role <> 'staff' then
    raise exception 'manager_can_only_remove_staff' using errcode = '42501';
  end if;

  delete from public.tenant_membership_invites
  where tenant_id = target_tenant_id and user_id = v_user_id;

  delete from public.memberships
  where id = target_membership_id and tenant_id = target_tenant_id;
end;
$$;

revoke all on function public.remove_tenant_member(uuid,uuid,uuid) from public, anon, authenticated;
grant execute on function public.remove_tenant_member(uuid,uuid,uuid) to service_role;

comment on function public.remove_tenant_member(uuid,uuid,uuid) is
  'Atomically authorizes and removes a non-owner tenant membership and its invitation idempotency record.';
