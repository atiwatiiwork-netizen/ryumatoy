-- ============================================================================
-- Ryuma — Phase F: remaining-balance payments. Paste into Supabase SQL Editor.
-- Safe to re-run. Customers pay the ส่วนต่าง (from shipping onward); admin approves.
-- ============================================================================

create table if not exists remaining_payments (
  id text primary key,
  ticket_id text references preorder_tickets(id) on delete cascade,
  user_id text references users(id),
  amount numeric not null,
  slip_url text,
  status text default 'pending',      -- 'pending' | 'approved'
  created_at timestamptz default now(),
  approved_at timestamptz
);
