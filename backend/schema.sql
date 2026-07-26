-- ═══════════════════════════════════════════════════════════════
-- QuickShop v1.0.0 — Supabase Schema
-- Run ENTIRE script in Supabase → SQL Editor → New Query
-- Safe to re-run on existing databases (all ops are idempotent)
-- ═══════════════════════════════════════════════════════════════
create extension if not exists "uuid-ossp";

-- ── CUSTOMERS ───────────────────────────────────────────────────
-- Guest-first: a customer record is created/matched by phone or email
-- at checkout. Optional Supabase auth account (auth_id) upgrades a
-- guest to a full account for order history without losing history —
-- linking happens by matching phone/email on first login.
create table if not exists customers (
  id            uuid primary key default uuid_generate_v4(),
  auth_id       uuid references auth.users(id) on delete set null,
  name          text,
  email         text,
  phone         text,
  notify_preference text not null default 'email', -- email | sms | push | telegram | all (comma-separated)
  telegram_chat_id text,
  is_blocked    boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create unique index if not exists idx_customers_email on customers (lower(email)) where email is not null;
create unique index if not exists idx_customers_phone on customers (phone) where phone is not null;
create index if not exists idx_customers_auth on customers(auth_id);

-- ── CATEGORIES ──────────────────────────────────────────────────
create table if not exists categories (
  id          uuid primary key default uuid_generate_v4(),
  name        text not null,
  color       text not null default '#3B82F6',
  icon        text not null default '📦', -- emoji placeholder (no images, per scope)
  sort_order  integer not null default 0,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);

-- ── PRODUCTS ────────────────────────────────────────────────────
create table if not exists products (
  id             uuid primary key default uuid_generate_v4(),
  category_id    uuid references categories(id) on delete set null,
  name           text not null,
  description    text,
  stock_count    integer not null default 0,
  low_stock_threshold integer not null default 5,
  is_active      boolean not null default true, -- soft toggle instead of hard delete
  unit_label     text not null default 'unit',  -- e.g. "sachet", "pack", "bottle"
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists idx_products_category on products(category_id);
create index if not exists idx_products_active on products(is_active);

-- ── PRODUCT PRICE TIERS (bulk pricing) ───────────────────────────
-- e.g. {min_qty:1,price:220}, {min_qty:5,price:1000}, {min_qty:10,price:1800}
-- Best matching tier = highest min_qty <= ordered qty.
create table if not exists product_price_tiers (
  id          uuid primary key default uuid_generate_v4(),
  product_id  uuid not null references products(id) on delete cascade,
  min_qty     integer not null,
  price       integer not null, -- kobo/cents-free integer currency unit (whole Naira as used in existing app)
  created_at  timestamptz not null default now(),
  unique(product_id, min_qty)
);
create index if not exists idx_tiers_product on product_price_tiers(product_id);

-- ── ORDERS ──────────────────────────────────────────────────────
-- type: catalog | restock_preorder | custom_preorder
-- status: pending | confirmed | rejected | fulfilled | cancelled
--   catalog orders auto-confirm at placement (autonomy-first)
--   pre-orders (restock/custom) start pending, need admin pricing/approval
create table if not exists orders (
  id                uuid primary key default uuid_generate_v4(),
  customer_id       uuid not null references customers(id) on delete cascade,
  type              text not null default 'catalog',
  status            text not null default 'pending',
  payment_method    text not null default 'pay_on_pickup', -- pay_online | pay_on_pickup
  payment_status    text not null default 'unpaid', -- unpaid | paid | refunded
  scheduled_for     timestamptz, -- null = ASAP order
  total_amount      integer not null default 0,
  admin_note        text,
  rejection_reason  text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists idx_orders_customer on orders(customer_id);
create index if not exists idx_orders_status on orders(status);
create index if not exists idx_orders_type on orders(type);
create index if not exists idx_orders_scheduled on orders(scheduled_for);

-- ── ORDER ITEMS ─────────────────────────────────────────────────
-- product_id is null for custom pre-orders (free-text item description).
-- customer_suggested_price: what the customer typed (pre-orders only).
-- admin_price: final price admin sets (pre-orders); for catalog items
--   this is filled automatically from the matched tier at order time.
create table if not exists order_items (
  id                        uuid primary key default uuid_generate_v4(),
  order_id                  uuid not null references orders(id) on delete cascade,
  product_id                uuid references products(id) on delete set null,
  description               text not null, -- product name snapshot, or free-text for custom pre-orders
  quantity                  integer not null default 1,
  customer_suggested_price  integer, -- pre-orders only
  admin_price               integer, -- final unit price used for total
  line_status               text not null default 'pending', -- pending | accepted | rejected (per-line for multi-item pre-orders)
  created_at                timestamptz not null default now()
);
create index if not exists idx_order_items_order on order_items(order_id);
create index if not exists idx_order_items_product on order_items(product_id);

-- ── PRICE CHANGE AUDIT LOG ──────────────────────────────────────
-- Tracks manual price changes: pre-order pricing decisions + tier edits.
create table if not exists price_audit_log (
  id           uuid primary key default uuid_generate_v4(),
  order_item_id uuid references order_items(id) on delete set null,
  product_id   uuid references products(id) on delete set null,
  changed_by   text not null default 'admin',
  old_price    integer,
  new_price    integer,
  note         text,
  created_at   timestamptz not null default now()
);

-- ── NOTIFICATIONS ───────────────────────────────────────────────
-- Reused pattern from ExpiryGuard: per-customer notification feed.
create table if not exists notifications (
  id          uuid primary key default uuid_generate_v4(),
  customer_id uuid references customers(id) on delete cascade,
  type        text not null default 'info', -- order_placed|order_confirmed|order_rejected|order_priced|order_ready|order_fulfilled|restock|reminder|system
  title       text not null,
  message     text not null,
  is_read     boolean not null default false,
  created_at  timestamptz not null default now()
);
create index if not exists idx_notifs_customer on notifications(customer_id);
create index if not exists idx_notifs_unread on notifications(customer_id, is_read);

-- ── ADMIN NOTIFICATIONS (low stock, restock demand signals) ─────
create table if not exists admin_notifications (
  id          uuid primary key default uuid_generate_v4(),
  type        text not null default 'info', -- low_stock|new_preorder|large_order
  title       text not null,
  message     text not null,
  is_read     boolean not null default false,
  created_at  timestamptz not null default now()
);

-- ── ADMIN SETTINGS (key-value, same pattern as ExpiryGuard) ──────
create table if not exists admin_settings (
  key text primary key, value text not null, updated_at timestamptz not null default now()
);
insert into admin_settings (key, value) values
  ('shop_name',                 'QuickShop'),
  ('currency_symbol',           '₦'),
  ('min_lead_time_hours',       '2'),      -- min lead time for scheduled orders
  ('large_order_threshold',     '0'),      -- 0 = disabled; else flags order for review (informational only)
  ('min_order_value',           '0'),
  ('delivery_fee',              '0'),
  ('reservation_hold_minutes',  '15'),     -- stock hold for unpaid pay_online orders
  ('preorder_rate_limit',       '5'),      -- max pending pre-orders per contact
  ('reminder_hours_before',     '3'),      -- scheduled order reminder lead time
  ('paystack_public_key',       ''),
  ('paystack_enabled',          'false'),
  ('allowed_channels',          'email,sms,push,telegram'),
  ('pulse_cost_sms',            '10'),
  ('pulse_cost_email',          '3'),
  ('pulse_cost_push',           '1'),
  ('pulse_cost_telegram',       '1'),
  ('telegram_enabled',          'true'),
  ('telegram_bot_username',     ''),
  ('push_enabled',              'true'),
  ('onesignal_app_id',          ''),
  ('app_version',               '1.0.0')
on conflict (key) do nothing;

-- ── TELEGRAM LINK CODES (reused pattern) ─────────────────────────
create table if not exists telegram_link_codes (
  id         uuid primary key default uuid_generate_v4(),
  chat_id    text not null,
  code       text not null,
  used       boolean not null default false,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists idx_tg_codes_code on telegram_link_codes(code) where not used;
create index if not exists idx_tg_codes_expires on telegram_link_codes(expires_at);

-- ── CUSTOMER DEVICES (push, reused pattern) ──────────────────────
create table if not exists customer_devices (
  id              uuid primary key default uuid_generate_v4(),
  customer_id     uuid not null references customers(id) on delete cascade,
  subscription_id text not null,
  device_label    text,
  last_seen_at    timestamptz not null default now(),
  created_at      timestamptz not null default now(),
  unique(subscription_id)
);
create index if not exists idx_devices_customer on customer_devices(customer_id);

-- ── STOCK RESERVATIONS (pay_online holds) ────────────────────────
create table if not exists stock_reservations (
  id          uuid primary key default uuid_generate_v4(),
  order_id    uuid not null references orders(id) on delete cascade,
  product_id  uuid not null references products(id) on delete cascade,
  quantity    integer not null,
  expires_at  timestamptz not null,
  released    boolean not null default false,
  created_at  timestamptz not null default now()
);
create index if not exists idx_reservations_expiry on stock_reservations(expires_at) where not released;

-- ── TRIGGERS ────────────────────────────────────────────────────
create or replace function update_updated_at() returns trigger as $$ begin new.updated_at=now(); return new; end; $$ language plpgsql;
drop trigger if exists trg_products_updated_at on products;
create trigger trg_products_updated_at before update on products for each row execute function update_updated_at();
drop trigger if exists trg_customers_updated_at on customers;
create trigger trg_customers_updated_at before update on customers for each row execute function update_updated_at();
drop trigger if exists trg_orders_updated_at on orders;
create trigger trg_orders_updated_at before update on orders for each row execute function update_updated_at();
drop trigger if exists trg_settings_updated_at on admin_settings;
create trigger trg_settings_updated_at before update on admin_settings for each row execute function update_updated_at();

-- ── RLS ─────────────────────────────────────────────────────────
-- All customer-facing access goes through the backend using the
-- service key, so RLS here is a defense-in-depth backstop (deny-all
-- for direct client access), same pattern as telegram_link_codes in
-- the reference app.
alter table customers enable row level security;
alter table categories enable row level security;
alter table products enable row level security;
alter table product_price_tiers enable row level security;
alter table orders enable row level security;
alter table order_items enable row level security;
alter table price_audit_log enable row level security;
alter table notifications enable row level security;
alter table admin_notifications enable row level security;
alter table admin_settings enable row level security;
alter table telegram_link_codes enable row level security;
alter table customer_devices enable row level security;
alter table stock_reservations enable row level security;

do $$ begin
  drop policy if exists "no direct client access" on customers;
  drop policy if exists "no direct client access" on categories;
  drop policy if exists "no direct client access" on products;
  drop policy if exists "no direct client access" on product_price_tiers;
  drop policy if exists "no direct client access" on orders;
  drop policy if exists "no direct client access" on order_items;
  drop policy if exists "no direct client access" on price_audit_log;
  drop policy if exists "no direct client access" on notifications;
  drop policy if exists "no direct client access" on admin_notifications;
  drop policy if exists "no direct client access" on admin_settings;
  drop policy if exists "no direct client access" on telegram_link_codes;
  drop policy if exists "no direct client access" on customer_devices;
  drop policy if exists "no direct client access" on stock_reservations;
exception when others then null; end $$;

create policy "no direct client access" on customers for all using (false);
create policy "no direct client access" on categories for all using (false);
create policy "no direct client access" on products for all using (false);
create policy "no direct client access" on product_price_tiers for all using (false);
create policy "no direct client access" on orders for all using (false);
create policy "no direct client access" on order_items for all using (false);
create policy "no direct client access" on price_audit_log for all using (false);
create policy "no direct client access" on notifications for all using (false);
create policy "no direct client access" on admin_notifications for all using (false);
create policy "no direct client access" on admin_settings for all using (false);
create policy "no direct client access" on telegram_link_codes for all using (false);
create policy "no direct client access" on customer_devices for all using (false);
create policy "no direct client access" on stock_reservations for all using (false);
-- ═══════════════════════════════════════════════════════════════
