-- ============================================================================
-- Ryuma — Phase E: shipping / ETA. Paste into Supabase SQL Editor. Safe to re-run.
-- ============================================================================

alter table products add column if not exists tracking_no text;
alter table products add column if not exists shipped_at timestamptz;

alter table shop_settings add column if not exists eta_min_days numeric default 7;
alter table shop_settings add column if not exists eta_max_days numeric default 10;
update shop_settings set eta_min_days = coalesce(eta_min_days, 7), eta_max_days = coalesce(eta_max_days, 10) where id = 'default';

-- allow the new lifecycle status
-- (status is a free-text column; 'delivered' just works — no enum change needed)
