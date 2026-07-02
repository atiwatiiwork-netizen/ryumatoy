-- ============================================================================
-- Ryuma — store the raw character name so the product form can round-trip edits.
-- Final display title (products.series_name) stays "ชื่อตัวละคร - ซีรีย์" as before.
-- Safe to re-run.
-- ============================================================================
alter table products add column if not exists character_name text;
