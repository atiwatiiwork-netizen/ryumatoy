-- ============================================================================
-- Ryuma — batch purchase tracking (who bought the reopened stock).
-- Paste into Supabase SQL Editor. Safe to re-run.
-- ============================================================================

alter table order_items add column if not exists batch_id text references product_batches(id);
alter table preorder_tickets add column if not exists batch_id text references product_batches(id);
