-- Allow tenant owners and managers to maintain public store identity fields.
-- Slug, active status, billing and ownership remain immutable through this grant.
create policy tenants_manager_update_profile
  on public.tenants
  for update
  using (public.has_tenant_role(id, array['owner','manager']::public.member_role[]))
  with check (public.has_tenant_role(id, array['owner','manager']::public.member_role[]));

revoke update on public.tenants from anon, authenticated;
grant update (name, phone, address) on public.tenants to authenticated;
