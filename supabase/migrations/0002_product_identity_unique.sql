-- Add product identity uniqueness as a forward-only migration.
-- This is safe whether 0001 was applied before or after this PR branch was created.
-- Existing duplicate rows are reported rather than deleted or silently changed.
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.products'::regclass
      and conname = 'products_tenant_category_name_key'
  ) then
    if exists (
      select 1
      from public.products
      group by tenant_id, category_id, name
      having count(*) > 1
    ) then
      raise exception
        'Cannot add products identity constraint: duplicate (tenant_id, category_id, name) rows exist. Review and resolve duplicates before retrying migration 0002.';
    end if;

    alter table public.products
      add constraint products_tenant_category_name_key
      unique (tenant_id, category_id, name);
  end if;
end
$$;
