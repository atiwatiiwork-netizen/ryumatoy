-- ============================================================================
-- Ryuma — homepage promo/announcement carousel. Paste into SQL Editor. Safe to re-run.
-- Adds a jsonb array of slides {id, image_url, link?, caption?} managed from the new
-- admin "หน้าแรก / โปรโมชั่น" page and shown at the top of the customer home.
-- ============================================================================

alter table shop_settings add column if not exists announcements jsonb not null default '[]'::jsonb;
