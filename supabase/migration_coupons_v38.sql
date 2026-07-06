-- ============================================================================
-- Ryuma - v38: COUPON SYSTEM. Paste into SQL Editor. Safe to re-run.
--
-- Coupons are now admin-created TEMPLATES (fixed baht off) handed to specific
-- customers as single-use CouponGrant rows. No public codes.
--   preorder coupon -> discounts the FINAL/remaining payment
--   instock coupon  -> discounts at checkout immediately
--   both            -> either
-- Depends on v20/v21/v33 helpers: app_user_id(), is_app_admin(), is_app_approved().
-- coupons already has RLS + coupons_read(approved) + coupons_admin from v21/v33;
-- only new columns/tables are added here.
-- ============================================================================

-- 1. coupons: template columns (legacy code/type/min_order/used_count stay, all nullable)
alter table coupons add column if not exists label text;
alter table coupons add column if not exists scope text default 'both';   -- preorder | instock | both
alter table coupons add column if not exists target_product_id text;
alter table coupons add column if not exists target_maker_id text;
alter table coupons add column if not exists active boolean default true;
alter table coupons add column if not exists created_at timestamptz default now();

-- 2. per-customer single-use grants
create table if not exists coupon_grants (
  id text primary key,
  coupon_id text not null references coupons(id) on delete cascade,
  user_id text not null references users(id) on delete cascade,
  status text not null default 'active',   -- active | used | revoked
  granted_at timestamptz not null default now(),
  used_at timestamptz,
  order_id text,      -- set when redeemed on an in-stock checkout
  ticket_id text,     -- set when redeemed on a pre-order final payment
  discount_amount int
);
create index if not exists coupon_grants_user_idx on coupon_grants(user_id);
create index if not exists coupon_grants_coupon_idx on coupon_grants(coupon_id);

-- 3. coupon redemption columns on orders + remaining_payments
alter table orders add column if not exists coupon_grant_id text;
alter table orders add column if not exists coupon_discount int;
alter table remaining_payments add column if not exists coupon_grant_id text;
alter table remaining_payments add column if not exists coupon_discount int;

-- 4. RLS for coupon_grants: a member sees + redeems their OWN; admin does everything.
alter table coupon_grants enable row level security;

drop policy if exists coupon_grants_read on coupon_grants;
create policy coupon_grants_read on coupon_grants for select
  using (user_id = app_user_id() or is_app_admin());

drop policy if exists coupon_grants_update on coupon_grants;
create policy coupon_grants_update on coupon_grants for update
  using (user_id = app_user_id() or is_app_admin())
  with check (user_id = app_user_id() or is_app_admin());

drop policy if exists coupon_grants_insert on coupon_grants;
create policy coupon_grants_insert on coupon_grants for insert
  with check (is_app_admin());

drop policy if exists coupon_grants_delete on coupon_grants;
create policy coupon_grants_delete on coupon_grants for delete
  using (is_app_admin());

-- 5. make sure the admin write policy on coupons exists (idempotent; v21 normally created it)
drop policy if exists coupons_admin on coupons;
create policy coupons_admin on coupons for all
  using (is_app_admin()) with check (is_app_admin());

-- self-check (optional):
-- select column_name from information_schema.columns where table_name='coupon_grants';
