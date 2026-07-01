-- ============================================================================
-- Ryuma — stock top-up audit log (เพิ่มสต๊อก with timestamp).
-- Paste into Supabase SQL Editor. Safe to re-run.
-- ============================================================================

create table if not exists stock_additions (
  id text primary key,
  product_id text references products(id) on delete cascade,
  qty numeric not null,
  note text,
  created_at timestamptz default now()
);
