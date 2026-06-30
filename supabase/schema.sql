-- ============================================================================
-- Ryuma — Supabase setup (schema + seed). Paste the whole file into the Supabase
-- SQL Editor and press Run. Safe to re-run (idempotent: IF NOT EXISTS / ON CONFLICT).
--
-- IDs are TEXT (human-readable, e.g. 'm-bandai', 'OP-2026-06-0001') to match the
-- app's data model and the ids generated client-side at checkout.
--
-- NOTE: Row Level Security is intentionally left OFF for now so the app works
-- before auth exists. We enable RLS in the Facebook OAuth step (step 4).
-- ============================================================================

-- ---- Tables ---------------------------------------------------------------

create table if not exists rank_tiers (
  name text primary key,                  -- 'bronze','silver','gold','diamond'
  min_spend numeric not null default 0,
  discount_percent numeric not null default 0,
  free_shipping_per_month int not null default 0,
  early_access_hours int not null default 0
);

create table if not exists users (
  id text primary key,
  display_name text,
  facebook_id text unique,
  rank text references rank_tiers(name),
  total_spent numeric default 0,
  avatar_url text,
  preferred_lang text default 'th'
);

create table if not exists manufacturers (
  id text primary key,
  name text not null
);

create table if not exists franchises (
  id text primary key,
  name text not null,
  abbr text not null,
  manufacturer_id text references manufacturers(id)
);

create table if not exists products (
  id text primary key,
  franchise_id text references franchises(id),
  series_name text not null,
  type text check (type in ('wcf','figure','resin','other')),
  description text,
  description_en text,
  images text[] default '{}',
  eta_note text,
  price_total numeric not null,
  deposit_amount numeric not null,
  is_stock boolean default false,
  stock_qty int,
  has_variants boolean default false,
  status text default 'open',
  created_at timestamptz default now()
);

create table if not exists product_variants (
  id text primary key,
  product_id text references products(id) on delete cascade,
  name text,
  price_total numeric,
  deposit_amount numeric,
  stock_qty int
);

create table if not exists coupons (
  id text primary key,
  code text unique,
  type text check (type in ('percent','fixed')),
  value numeric,
  min_order numeric default 0,
  max_uses int,
  used_count int default 0,
  rank_required text,
  expires_at timestamptz
);

create table if not exists orders (
  id text primary key,
  user_id text references users(id),
  total_deposit numeric,
  slip_url text,
  status text default 'pending_approval',  -- pending_approval | approved | rejected
  created_at timestamptz default now(),
  approved_at timestamptz
);

create table if not exists order_items (
  id text primary key,
  order_id text references orders(id) on delete cascade,
  product_id text references products(id),
  variant_id text,
  qty int default 1,
  deposit_amount numeric,
  coupon_id text
);

create table if not exists preorder_tickets (
  id text primary key,
  ticket_no text unique,                   -- OP-2026-06-0001
  product_id text references products(id),
  variant_id text,
  owner_id text references users(id),
  original_buyer_id text references users(id),
  qty int,
  deposit_paid numeric,
  remaining_amount numeric,
  remaining_paid numeric default 0,
  status text default 'active',            -- pending_approval | active | paid_full | transferred
  product_status text default 'open',
  qr_code_url text,
  created_at timestamptz default now(),
  approved_at timestamptz
);

create table if not exists ticket_transfers (
  id text primary key,
  ticket_id text references preorder_tickets(id),
  from_user_id text references users(id),
  to_user_id text references users(id),
  asking_price numeric,
  status text default 'listed',            -- listed | pending_admin | approved | cancelled
  note text,
  listed_at timestamptz default now(),
  approved_at timestamptz
);

create table if not exists shop_settings (
  id text primary key default 'default',
  bank_name text,
  bank_account text,
  promptpay_number text,
  line_oa_id text
);

-- ---- Seed data (matches the preview; edit/replace your real catalog in step 3) ----

insert into rank_tiers (name, min_spend, discount_percent, free_shipping_per_month, early_access_hours) values
  ('bronze', 0, 0, 0, 0),
  ('silver', 5000, 3, 0, 0),
  ('gold', 20000, 5, 1, 24),
  ('diamond', 50000, 8, 99, 48)
on conflict (name) do nothing;

insert into users (id, display_name, facebook_id, rank, total_spent, preferred_lang) values
  ('u-me', 'Atiwat T.', 'fb-001', 'gold', 32400, 'th'),
  ('u-2', 'Ploy K.', 'fb-002', 'silver', 8200, 'th'),
  ('u-3', 'Nut R.', 'fb-003', 'diamond', 64000, 'th'),
  ('u-admin', 'Ryuma Admin', null, 'diamond', 0, 'th')
on conflict (id) do nothing;

insert into manufacturers (id, name) values
  ('m-bandai', 'Bandai'),
  ('m-megahouse', 'MegaHouse'),
  ('m-prime1', 'Prime1Studio')
on conflict (id) do nothing;

insert into franchises (id, name, abbr, manufacturer_id) values
  ('f-op', 'One Piece', 'op', 'm-bandai'),
  ('f-nr', 'Naruto', 'nr', 'm-megahouse'),
  ('f-db', 'Dragon Ball', 'db', 'm-prime1'),
  ('f-bl', 'Bleach', 'bl', 'm-megahouse')
on conflict (id) do nothing;

insert into products (id, franchise_id, series_name, type, description, images, eta_note, price_total, deposit_amount, is_stock, stock_qty, has_variants, status, created_at) values
  ('p-1', 'f-op', 'WCF Vol.38 — Luffy Gear 5', 'wcf', 'World Collectable Figure ลอตใหม่ล่าสุด ลูฟี่กียร์ 5 พร้อมฐานพิเศษ', '{}', 'Q3 2026', 1290, 590, false, null, true, 'open', '2026-06-20'),
  ('p-2', 'f-nr', 'GEM Series — Uchiha Sasuke', 'figure', 'GEM Series ซาสึเกะ ดีเทลสูง พร้อมเอฟเฟกต์ชิโดริ', '{}', 'Q4 2026', 4200, 1500, false, null, false, 'production', '2026-06-12'),
  ('p-3', 'f-db', 'Super Saiyan Goku 1/4', 'resin', 'เรซินสเกล 1/4 โกคูซูเปอร์ไซย่า งานปั้นพรีเมียม Prime1Studio', '{}', 'Q1 2027', 28900, 9000, false, null, false, 'shipping', '2026-05-30'),
  ('p-4', 'f-op', 'WCF Vol.37 — Zoro', 'wcf', 'โซโลลอตก่อนหน้า ถึงไทยแล้ว พร้อมเรียกเก็บส่วนต่าง', '{}', 'ถึงไทยแล้ว', 1190, 500, false, null, false, 'arrived', '2026-04-18'),
  ('p-5', 'f-bl', 'GEM — Kurosaki Ichigo', 'figure', 'อิจิโกะร่างบังไค พร้อมส่งทันที', '{}', 'พร้อมส่ง', 3600, 3600, true, 4, false, 'open', '2026-06-25'),
  ('p-6', 'f-nr', 'WCF — Kakashi Hatake', 'wcf', 'คาคาชิ WCF พร้อมส่ง', '{}', 'พร้อมส่ง', 890, 890, true, 7, false, 'open', '2026-06-22')
on conflict (id) do nothing;

insert into product_variants (id, product_id, name, price_total, deposit_amount) values
  ('v-1a', 'p-1', 'Random Box (สุ่ม)', 1290, 590),
  ('v-1b', 'p-1', 'Single — Luffy', 1490, 690),
  ('v-1c', 'p-1', 'Full Set (6 ตัว)', 6900, 3000)
on conflict (id) do nothing;

insert into coupons (id, code, type, value, min_order, max_uses, used_count, rank_required) values
  ('c-1', 'RYUMA50', 'fixed', 50, 500, 100, 12, null),
  ('c-2', 'GOLD5', 'percent', 5, 0, null, 3, 'gold')
on conflict (id) do nothing;

insert into orders (id, user_id, total_deposit, slip_url, status, created_at) values
  ('o-1', 'u-2', 2090, '', 'pending_approval', '2026-06-29T10:24:00'),
  ('o-2', 'u-3', 9000, '', 'pending_approval', '2026-06-30T08:05:00')
on conflict (id) do nothing;

insert into order_items (id, order_id, product_id, variant_id, qty, deposit_amount) values
  ('oi-1', 'o-1', 'p-1', 'v-1a', 1, 590),
  ('oi-2', 'o-1', 'p-2', null, 1, 1500),
  ('oi-3', 'o-2', 'p-3', null, 1, 9000)
on conflict (id) do nothing;

insert into preorder_tickets (id, ticket_no, product_id, variant_id, owner_id, original_buyer_id, qty, deposit_paid, remaining_amount, remaining_paid, status, product_status, qr_code_url, created_at, approved_at) values
  ('t-1', 'OP-2026-06-0001', 'p-1', 'v-1b', 'u-me', 'u-me', 1, 690, 800, 0, 'active', 'open', '', '2026-06-21', '2026-06-21'),
  ('t-2', 'NR-2026-06-0007', 'p-2', null, 'u-me', 'u-me', 1, 1500, 2700, 0, 'active', 'production', '', '2026-06-13', '2026-06-13'),
  ('t-3', 'OP-2026-04-0012', 'p-4', null, 'u-me', 'u-me', 1, 500, 690, 690, 'paid_full', 'arrived', '', '2026-04-19', '2026-04-19')
on conflict (id) do nothing;

insert into ticket_transfers (id, ticket_id, from_user_id, asking_price, status, note, listed_at) values
  ('tr-1', 't-3', 'u-me', 1500, 'listed', 'จ่ายครบแล้ว พร้อมโอน', '2026-06-28')
on conflict (id) do nothing;

insert into shop_settings (id, bank_name, bank_account, promptpay_number, line_oa_id) values
  ('default', 'ไทยพาณิชย์ (SCB)', 'Ryuma Toy Shop', '081-234-5678', '@ryumatoy')
on conflict (id) do nothing;
