-- ============================================================================
-- Ryuma — Phase B: price snapshot on order items. Paste into Supabase SQL Editor.
-- Safe to re-run. Locks the customer's price at order time (unit_price/unit_deposit),
-- so later product price edits never change existing buyers' tickets.
-- ============================================================================

alter table order_items add column if not exists unit_price numeric;
alter table order_items add column if not exists unit_deposit numeric;
