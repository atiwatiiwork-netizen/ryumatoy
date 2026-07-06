-- ============================================================================
-- Ryuma — v37: in-stock origin tag. Paste into SQL Editor. Safe to re-run.
-- Admin-only marker: an in-stock product came from converting a finished pre-order
-- ('preorder') or was created new ('manual'). Customers just see "พร้อมส่ง".
-- ============================================================================
alter table products add column if not exists stock_origin text;
