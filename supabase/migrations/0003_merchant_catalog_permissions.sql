-- Merchant catalog management: grant write capability to authenticated users.
-- Existing RLS policies remain the tenant/role boundary (owner and manager only).
-- No DELETE grant: catalog items/categories are archived or marked unavailable.
grant insert, update on public.categories to authenticated;
grant insert, update on public.products to authenticated;
