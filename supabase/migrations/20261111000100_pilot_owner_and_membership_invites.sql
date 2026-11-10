-- One-time, explicitly configured first-owner bootstrap.
-- Membership invitations are managed by trusted server routes using the service role.
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

alter table public.pilot_owner_bootstrap_state enable row level security;
revoke all on public.pilot_owner_bootstrap_state from public, anon, authenticated;
revoke all on public.pilot_owner_bootstrap_state from service_role;

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
grant select, insert, update, delete on public.tenant_membership_invites to service_role;

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
