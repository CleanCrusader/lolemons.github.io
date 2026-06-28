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

drop policy if exists "Public can subscribe" on subscribers;
create policy "Public can subscribe" on subscribers
  for insert
  to anon
  with check (true);

-- No select/update/delete policy for anon — the public key can add a row
-- and nothing else. Reading the list back requires the service_role key
-- (e.g. from a future export/email-send script), never the public site.

create index if not exists orders_pii_purge_after_idx on orders (pii_purge_after) where pii_purged = false;
create index if not exists orders_status_idx on orders (status);

-- =========================================================
-- Direct-to-consumer checkout (Stripe + FBA via MCF)
-- =========================================================
--
-- 3. `inventory` — mirrors live FBA available-to-sell quantity per SKU,
--    refreshed every few minutes by scripts/sync-inventory.js. Stock counts
--    aren't PII, so it's fine for this to be publicly readable — the site's
--    "Buy" button reads it directly to show in-stock/out-of-stock state.
--    `stripe_price_id` lives here too: one place to manage which Stripe
--    Price backs each SKU, editable straight in the Supabase table editor.
--
-- 4. `inventory_holds` — short-lived reservations created the moment someone
--    starts checkout, so two customers can't both "win" the last unit while
--    their payment is in flight. Consumed on successful payment, released
--    on checkout expiry/abandonment.
--
-- 5. `dtc_orders` — orders paid via Stripe and fulfilled from FBA stock via
--    Amazon's Fulfillment Outbound API. This data never touches Amazon's
--    marketplace orders, so it's fully yours — Amazon's PII retention rule
--    doesn't apply here (ordinary privacy practice still does).

create table if not exists inventory (
  sku text primary key,
  asin text,
  stripe_price_id text,
  available_quantity integer not null default 0,
  updated_at timestamptz not null default now()
);

alter table inventory enable row level security;

drop policy if exists "Public can read inventory" on inventory;
create policy "Public can read inventory" on inventory
  for select
  to anon
  using (true);
-- No insert/update/delete policy for anon — only service_role
-- (sync-inventory.js and the checkout webhook) can write.

create table if not exists inventory_holds (
  id bigint generated always as identity primary key,
  sku text not null references inventory(sku),
  quantity integer not null,
  stripe_session_id text unique not null,
  status text not null default 'active', -- active | consumed | released
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

alter table inventory_holds enable row level security;
-- No anon policies at all — holds are purely a server-side bookkeeping
-- mechanism between create-checkout-session and the Stripe webhook.

create index if not exists inventory_holds_active_idx
  on inventory_holds (sku) where status = 'active';

-- Atomically reserve stock for a checkout attempt. Returns true if the
-- reservation succeeded, false if there isn't enough unheld stock left.
-- The `for update` lock on the inventory row serializes concurrent
-- attempts for the same SKU, which is what actually prevents overselling.
create or replace function try_reserve_inventory(
  p_sku text,
  p_qty integer,
  p_session_id text,
  p_hold_minutes integer default 60
) returns boolean
language plpgsql
as $$
declare
  v_available integer;
  v_held integer;
begin
  select available_quantity into v_available from inventory where sku = p_sku for update;

  if v_available is null then
    return false;
  end if;

  select coalesce(sum(quantity), 0) into v_held
    from inventory_holds
    where sku = p_sku and status = 'active' and expires_at > now();

  if v_available - v_held >= p_qty then
    insert into inventory_holds (sku, quantity, stripe_session_id, expires_at)
    values (p_sku, p_qty, p_session_id, now() + (p_hold_minutes || ' minutes')::interval);
    return true;
  end if;

  return false;
end;
$$;

-- Called by the Stripe webhook once payment succeeds: marks the hold
-- consumed and actually decrements available_quantity (rather than
-- waiting for the next FBA inventory poll), so the site reflects the
-- sale immediately.
create or replace function consume_inventory_hold(p_session_id text)
returns void
language plpgsql
as $$
declare
  v_sku text;
  v_qty integer;
begin
  select sku, quantity into v_sku, v_qty
    from inventory_holds
    where stripe_session_id = p_session_id and status = 'active';

  if v_sku is not null then
    update inventory_holds set status = 'consumed' where stripe_session_id = p_session_id;
    update inventory set available_quantity = greatest(available_quantity - v_qty, 0), updated_at = now()
      where sku = v_sku;
  end if;
end;
$$;

-- Called on Stripe's checkout.session.expired event: releases the hold
-- without touching available_quantity (it was never decremented for an
-- unpaid hold, only reserved against).
create or replace function release_inventory_hold(p_session_id text)
returns void
language plpgsql
as $$
begin
  update inventory_holds set status = 'released'
    where stripe_session_id = p_session_id and status = 'active';
end;
$$;

create table if not exists dtc_orders (
  id bigint generated always as identity primary key,
  stripe_session_id text unique not null,
  stripe_payment_intent text,
  customer_email text not null,
  customer_name text,
  ship_address_line1 text,
  ship_address_line2 text,
  ship_city text,
  ship_state text,
  ship_postal_code text,
  ship_country text,
  items jsonb not null,
  amount_total numeric,
  currency text,
  shipping_speed text, -- standard | expedited
  shipping_amount numeric, -- what they paid for shipping specifically
  status text not null default 'paid', -- paid | fulfilling | shipped | failed
  amazon_fulfillment_order_id text,
  tracking_number text,
  carrier_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table dtc_orders enable row level security;
-- No anon policies — only the Cloudflare Pages Function (service_role) can
-- read or write this table.

-- =========================================================
-- Verified-purchase reviews
-- =========================================================
--
-- Every review in this table is, by construction, from a verified buyer —
-- the only way a row gets inserted is via the Worker's submit-review
-- route, which checks dtc_orders for a completed purchase of that SKU
-- under that email *before* allowing the insert. There's no "unverified"
-- path, so every review the public sees is a verified purchase, no
-- separate flag needed.
--
-- customer_email lives on the base table for that verification logic and
-- spam-prevention (one review per email per SKU), but must never be
-- publicly queryable — anon has zero policies on this table. Instead,
-- public_reviews is a view that excludes the email column entirely and
-- only ever shows approved rows, regardless of what RLS does or doesn't
-- allow on the base table.

create table if not exists reviews (
  id bigint generated always as identity primary key,
  sku text not null,
  customer_name text not null,
  customer_email text not null,
  rating integer not null check (rating between 1 and 5),
  review_text text not null,
  status text not null default 'pending', -- pending | approved | rejected
  created_at timestamptz not null default now()
);

alter table reviews enable row level security;
-- Intentionally zero anon policies — service_role (the Worker) only.

create or replace view public_reviews as
  select id, sku, customer_name, rating, review_text, created_at
  from reviews
  where status = 'approved';

grant select on public_reviews to anon;

create index if not exists reviews_sku_idx on reviews (sku, status);

-- =========================================================
-- Admin authentication (review moderation page)
-- =========================================================
--
-- Singleton row (id is always 'admin' -- there's only one admin account).
-- password_hash is a PBKDF2 derivation, never the plaintext password --
-- this table being read by anyone doesn't expose anything usable on its
-- own. Zero anon policies, same as dtc_orders: service_role only.

create table if not exists admin_credentials (
  id text primary key default 'admin',
  password_hash text,
  salt text,
  reset_token text,
  reset_token_expires_at timestamptz,
  updated_at timestamptz not null default now()
);

alter table admin_credentials enable row level security;

insert into admin_credentials (id) values ('admin') on conflict (id) do nothing;
