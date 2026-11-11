-- Recoverable, idempotent Pilot owner bootstrap saga.
-- Reserve the one-time claim before creating any Supabase Auth user or sending email.
alter table public.pilot_owner_bootstrap_state
  add column reservation_id uuid unique,
  add column reserved_email text,
  add column reserved_at timestamptz,
  add column auth_user_id uuid references auth.users(id) on delete restrict;

alter table public.pilot_owner_bootstrap_state
  add constraint pilot_owner_bootstrap_reservation_shape_check
  check (
    (reservation_id is null and reserved_email is null and reserved_at is null and auth_user_id is null and tenant_id is null and completed_at is null)
    or
    (reservation_id is not null and reserved_email = lower(btrim(reserved_email)) and
     reserved_at is not null and tenant_id is not null and completed_at is null)
    or
    (reservation_id is not null and reserved_email = lower(btrim(reserved_email)) and
     reserved_at is not null and auth_user_id is not null and tenant_id is not null and completed_at is not null)
  );

create or replace function public.reserve_pilot_owner_bootstrap(
  target_tenant_id uuid,
  target_email text,
  target_reservation_id uuid
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
  if target_email is null or target_email <> lower(btrim(target_email)) or
     length(target_email) not between 3 and 254 or target_reservation_id is null then
    raise exception 'invalid_bootstrap_reservation' using errcode = '22023';
  end if;

  select * into v_claim
  from public.pilot_owner_bootstrap_state
  where singleton = true
  for update;

  if not found then
    raise exception 'pilot_owner_bootstrap_state_missing' using errcode = '55000';
  end if;

  if v_claim.completed_at is not null then
    raise exception 'pilot_owner_bootstrap_already_completed' using errcode = '55000';
  end if;

  if v_claim.reservation_id is not null then
    if v_claim.reservation_id = target_reservation_id
       and v_claim.tenant_id = target_tenant_id
       and v_claim.reserved_email = target_email then
      return;
    end if;
    raise exception 'pilot_owner_bootstrap_reserved' using errcode = '55000';
  end if;

  if not exists (
    select 1 from public.tenants where id = target_tenant_id and is_active = true
  ) then
    raise exception 'pilot_tenant_not_found_or_inactive' using errcode = 'P0002';
  end if;
  if exists (
    select 1 from public.memberships
    where tenant_id = target_tenant_id and role = 'owner'
  ) then
    raise exception 'pilot_tenant_already_has_owner' using errcode = '55000';
  end if;

  update public.pilot_owner_bootstrap_state
  set tenant_id = target_tenant_id,
      reservation_id = target_reservation_id,
      reserved_email = target_email,
      reserved_at = now()
  where singleton = true;
end;
$$;

create or replace function public.attach_pilot_owner_auth_user(
  target_reservation_id uuid,
  target_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_claim public.pilot_owner_bootstrap_state%rowtype;
  v_auth_email text;
begin
  if coalesce(current_setting('request.jwt.claim.role', true), '') <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;

  select * into v_claim
  from public.pilot_owner_bootstrap_state
  where singleton = true
  for update;

  if not found or v_claim.reservation_id <> target_reservation_id then
    raise exception 'pilot_owner_reservation_mismatch' using errcode = '55000';
  end if;
  if v_claim.auth_user_id is not null then
    if v_claim.auth_user_id = target_user_id then return; end if;
    raise exception 'pilot_owner_auth_user_conflict' using errcode = '55000';
  end if;

  select lower(email) into v_auth_email from auth.users where id = target_user_id;
  if v_auth_email is null or v_auth_email <> v_claim.reserved_email then
    raise exception 'pilot_owner_auth_email_mismatch' using errcode = '42501';
  end if;

  update public.pilot_owner_bootstrap_state
  set auth_user_id = target_user_id
  where singleton = true;
end;
$$;

create or replace function public.complete_pilot_owner_bootstrap(target_reservation_id uuid)
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

  if not found or v_claim.reservation_id <> target_reservation_id then
    raise exception 'pilot_owner_reservation_mismatch' using errcode = '55000';
  end if;
  if v_claim.completed_at is not null then
    return;
  end if;
  if v_claim.auth_user_id is null or not exists (
    select 1 from auth.users where id = v_claim.auth_user_id
      and lower(email) = v_claim.reserved_email
  ) then
    raise exception 'pilot_owner_auth_user_not_attached' using errcode = 'P0002';
  end if;
  if not exists (
    select 1 from public.tenants where id = v_claim.tenant_id and is_active = true
  ) then
    raise exception 'pilot_tenant_not_found_or_inactive' using errcode = 'P0002';
  end if;
  if exists (
    select 1 from public.memberships
    where tenant_id = v_claim.tenant_id and role = 'owner'
  ) then
    raise exception 'pilot_tenant_already_has_owner' using errcode = '55000';
  end if;

  insert into public.memberships(tenant_id, user_id, role)
  values (v_claim.tenant_id, v_claim.auth_user_id, 'owner');

  update public.pilot_owner_bootstrap_state
  set completed_at = now()
  where singleton = true;
end;
$$;

revoke all on function public.reserve_pilot_owner_bootstrap(uuid,text,uuid) from public, anon, authenticated;
revoke all on function public.attach_pilot_owner_auth_user(uuid,uuid) from public, anon, authenticated;
revoke all on function public.complete_pilot_owner_bootstrap(uuid) from public, anon, authenticated;
grant execute on function public.reserve_pilot_owner_bootstrap(uuid,text,uuid) to service_role;
grant execute on function public.attach_pilot_owner_auth_user(uuid,uuid) to service_role;
grant execute on function public.complete_pilot_owner_bootstrap(uuid) to service_role;

comment on function public.reserve_pilot_owner_bootstrap(uuid,text,uuid) is
  'Atomically reserves the single Pilot owner bootstrap before any Auth invite side effect; same reservation is safely retryable.';
comment on function public.attach_pilot_owner_auth_user(uuid,uuid) is
  'Attaches only the Auth user whose normalized email matches the reserved bootstrap email; idempotent for the same user.';
comment on function public.complete_pilot_owner_bootstrap(uuid) is
  'Completes the reserved Pilot owner bootstrap transactionally and idempotently; never deletes Auth users on ambiguous outcomes.';

-- Remove the pre-saga RPC so there is only one supported bootstrap path.
drop function public.bootstrap_pilot_owner(uuid, uuid);
