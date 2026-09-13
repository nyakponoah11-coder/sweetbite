create table if not exists public.orders (
  order_key bigint generated always as identity primary key,
  id text not null,
  branch text not null,
  customer_phone text not null,
  food text not null,
  base_price numeric not null default 0,
  soup text,
  included_chicken integer not null default 0,
  proteins jsonb not null default '[]'::jsonb,
  protein_summary text not null default '',
  total numeric not null default 0,
  fulfillment text not null,
  address text,
  status text not null,
  created_at timestamptz not null
);

-- Upgrade an orders table created by an earlier version of the bot.
alter table public.orders add column if not exists order_key bigint generated always as identity;
alter table public.orders add column if not exists branch text;
alter table public.orders add column if not exists customer_phone text;
alter table public.orders add column if not exists food text;
alter table public.orders add column if not exists base_price numeric default 0;
alter table public.orders add column if not exists soup text;
alter table public.orders add column if not exists included_chicken integer default 0;
alter table public.orders add column if not exists proteins jsonb default '[]'::jsonb;
alter table public.orders add column if not exists protein_summary text default '';
alter table public.orders add column if not exists total numeric default 0;
alter table public.orders add column if not exists fulfillment text;
alter table public.orders add column if not exists address text;
alter table public.orders add column if not exists status text;
alter table public.orders add column if not exists created_at timestamptz;

create index if not exists orders_branch_created_at_idx
  on public.orders (branch, created_at);

create index if not exists orders_id_idx on public.orders (id);

alter table public.orders enable row level security;