-- supabase/schema.sql
--
-- Run this once in the Supabase SQL Editor (Project > SQL Editor > New query).
--
-- Two tables, two different rules, because they serve two different purposes:
--
-- 1. `orders` — operational fulfillment records pulled from Amazon SP-API.
--    Contains buyer PII (name, address). Per Amazon's Data Protection Policy,
--    this data may only be used to fulfill the order and must not be kept
--    longer than necessary — the purge-old-pii job (see scripts/) nulls out
--    the PII columns ~30 days after shipment. No anon access at all; only
--    the service_role key (used server-side in GitHub Actions) can touch it.
--
-- 2. `subscribers` — your own opt-in marketing list. Populated only by people
--    submitting the signup form on your site, never from Amazon order data.
--    The public anon key may INSERT into this table and nothing else —
--    can't read, update, or delete — enforced by the RLS policy below.

create table if not exists orders (
  id bigint generated always as identity primary key,
  amazon_order_id text unique not null,
  status text not null default 'unshipped',
  fulfillment_channel text,
  buyer_name text,
  ship_address_line1 text,
  ship_address_line2 text,
  ship_city text,
  ship_state text,
  ship_postal_code text,
  ship_country text,
  order_total numeric,
  currency text,
  carrier_code text,
  tracking_number text,
  purchase_date timestamptz,
  ship_by timestamptz,
  shipped_at timestamptz,
  pii_purge_after timestamptz,
  pii_purged boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table orders enable row level security;
-- Intentionally no policies here. With RLS on and zero policies, every
-- role except service_role is denied by default — anon and authenticated
-- get no access at all, which is what we want for a table full of PII.

create table if not exists subscribers (
  id bigint generated always as identity primary key,
  email text unique not null,
  name text,
  source text not null default 'website',
  consented boolean not null default true,
  created_at timestamptz not null default now()
);

alter table subscribers enable row level security;

create policy "Public can subscribe" on subscribers
  for insert
  to anon
  with check (true);

-- No select/update/delete policy for anon — the public key can add a row
-- and nothing else. Reading the list back requires the service_role key
-- (e.g. from a future export/email-send script), never the public site.

create index if not exists orders_pii_purge_after_idx on orders (pii_purge_after) where pii_purged = false;
create index if not exists orders_status_idx on orders (status);
