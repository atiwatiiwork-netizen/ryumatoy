-- ============================================================================
-- Ryuma — MEMBERS-ONLY CATALOG (v33). Paste into SQL Editor. Safe to re-run.
--
-- Closes the API-level scraping hole: after this, the anon key can NO LONGER read
-- the catalog (products/makers/series/prices/coupons/…). Only APPROVED members and
-- admins can. The anonymous landing page still needs the first banner, so
-- shop_settings stays publicly readable.
--
-- Depends on v20/v21 helpers: app_user_id(), is_app_admin() (SECURITY DEFINER).
-- Only the SELECT (_read) policies change here; the admin write (_admin) policies
-- from v21 are untouched.
-- ============================================================================

-- approved member (or admin) — the gate for reading the catalog.
create or replace function is_app_approved() returns boolean
  language sql stable security definer set search_path = public as $$
  select is_app_admin() or exists (
    select 1 from users u where u.id = app_user_id() and u.approved is not false
  );
$$;

do $$
declare
  -- everything a competitor could scrape → approved-only
  gated text[] := array['rank_tiers','categories','manufacturers','franchises','series',
    'products','product_variants','product_batches','stock_additions','coupons','payment_accounts'];
  t text;
begin
  foreach t in array gated loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', t||'_read', t);
    execute format('create policy %I on %I for select using (is_app_approved())', t||'_read', t);
  end loop;

  -- shop_settings stays publicly readable — the anonymous landing shows the first banner from it.
  execute 'alter table shop_settings enable row level security';
  execute 'drop policy if exists shop_settings_read on shop_settings';
  execute 'create policy shop_settings_read on shop_settings for select using (true)';
end $$;

-- ── quick self-check (optional): run as anon → these should return 0 / error-free empties ──
-- set role anon;  select count(*) from products;   -- expect 0
-- select count(*) from shop_settings;              -- expect ≥ 1 (banner still readable)
-- reset role;
