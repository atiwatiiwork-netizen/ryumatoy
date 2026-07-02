-- ============================================================================
-- Ryuma — per-variant image. Paste into SQL Editor. Safe to re-run.
-- Each product variant (สีแดง/สีฟ้า/...) can carry its own image, shown when the
-- customer selects that variant. The variant flows to the order/ticket via variant_id.
-- ============================================================================
alter table product_variants add column if not exists image_url text;
