-- ============================================================================
-- Ryuma — Phase A: pricing calculator + WCF/Mega deposit tiers.
-- Paste into Supabase SQL Editor. Safe to re-run.
-- ============================================================================

-- Product: deposit tier + yuan cost (for the price calculator)
alter table products add column if not exists wcf_type text;   -- 'wcf' | 'mega_wcf'
alter table products add column if not exists cost_yuan numeric;

-- Pricing config on the settings row (editable in admin):
-- price(฿) = baht_base + (yuan − yuan_base) × baht_per_yuan
alter table shop_settings add column if not exists yuan_base numeric default 288;
alter table shop_settings add column if not exists baht_base numeric default 1550;
alter table shop_settings add column if not exists baht_per_yuan numeric default 5;
alter table shop_settings add column if not exists deposit_wcf numeric default 300;
alter table shop_settings add column if not exists deposit_mega numeric default 500;

update shop_settings set
  yuan_base = coalesce(yuan_base, 288),
  baht_base = coalesce(baht_base, 1550),
  baht_per_yuan = coalesce(baht_per_yuan, 5),
  deposit_wcf = coalesce(deposit_wcf, 300),
  deposit_mega = coalesce(deposit_mega, 500)
where id = 'default';
