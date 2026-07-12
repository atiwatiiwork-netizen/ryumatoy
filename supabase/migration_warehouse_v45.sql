-- ============================================================================
-- Ryuma - v45: warehouse-confirm gate (China warehouse arrival) columns.
-- Paste into the Supabase SQL Editor. Safe to re-run (idempotent).
--
-- Adds the maker SF tracking + per-ticket warehouse-arrival fields used by the
-- "ยืนยันโกดัง" gate (status ผลิต -> เดินทางมาไทย). No new tables, no RLS changes
-- (existing per-row policies on products / preorder_tickets / sourcing_requests
-- already cover these columns). All writes happen in the ADMIN session.
-- ============================================================================

-- maker SF tracking (internal only) — one per product for pre-order/special rounds
alter table products add column if not exists sf_code text;

-- per-ticket warehouse arrival: the matched เข้าโกดัง date = the real ETA start
alter table preorder_tickets add column if not exists warehouse_at date;
alter table preorder_tickets add column if not exists warehouse_transport text;  -- truck | ship
alter table preorder_tickets add column if not exists warehouse_slip text;       -- the table screenshot (evidence)

-- sourcing keeps its own by-case SF
alter table sourcing_requests add column if not exists sf_code text;

-- self-check (optional):
-- select column_name from information_schema.columns
--   where table_name='preorder_tickets' and column_name like 'warehouse%';
