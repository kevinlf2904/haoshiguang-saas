-- Public customer order tracking uses a high-entropy bearer token.
-- Only a keyed hash is stored; anonymous/authenticated roles cannot read this table.
create table public.public_order_tracking (
  order_id uuid primary key references public.orders(id) on delete cascade,
  token_hash text not null unique
    check (length(token_hash) = 64 and token_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now()
);

alter table public.public_order_tracking enable row level security;
revoke all on public.public_order_tracking from public, anon, authenticated;

grant all on public.public_order_tracking to service_role;
