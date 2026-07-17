-- ============================================================================
-- Ryuma - v50: sourcing memo — multiple customers per deal.
-- Paste into the Supabase SQL Editor. Safe to re-run (idempotent).
--
-- One product deal can have several buyers ("5 pcs: 1.Suthep 2.Jirapat ...").
-- customers = jsonb array [{name, fb_link?}, ...]. customer_name/fb_link stay
-- (legacy rows + always mirror the FIRST customer, keeps not-null happy).
-- RLS unchanged (v49 admin-only policies already cover new columns).
-- ============================================================================

alter table sourcing_memos add column if not exists customers jsonb;

-- self-check (optional):
-- select column_name from information_schema.columns where table_name='sourcing_memos';
