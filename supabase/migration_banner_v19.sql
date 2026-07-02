-- ============================================================================
-- Ryuma — homepage banner control + link orders to stock reservations. SQL Editor.
-- Safe to re-run.
-- ============================================================================

alter table shop_settings add column if not exists hero_product_id text;
alter table shop_settings add column if not exists hero_image_url  text;

alter table orders add column if not exists reservation_ids jsonb;
