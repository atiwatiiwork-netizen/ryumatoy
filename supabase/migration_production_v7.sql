-- ============================================================================
-- Ryuma — Phase C: close-order / production round. Paste into Supabase SQL Editor.
-- Safe to re-run. production_qty = final qty ordered from the maker; surplus_qty =
-- amount above the pre-orders that becomes shop stock.
-- ============================================================================

alter table products add column if not exists production_qty numeric;
alter table products add column if not exists surplus_qty numeric;
