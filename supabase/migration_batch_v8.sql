-- ============================================================================
-- Ryuma — Phase D: reopened stock batches (lots on the same SKU).
-- Paste into Supabase SQL Editor. Safe to re-run.
-- ============================================================================

create table if not exists product_batches (
  id text primary key,
  product_id text references products(id) on delete cascade,
  label text,
  price_total numeric not null,
  deposit_amount numeric not null,
  stock_qty numeric not null default 0,
  status text default 'open',        -- 'open' | 'closed'
  created_at timestamptz default now()
);
