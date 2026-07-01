-- ============================================================================
-- Ryuma — Rank system (Bronze/Silver/Gold). Paste into Supabase SQL Editor.
-- Safe to re-run. Piece-based ranks + per-rank deposit/in-stock perks.
-- ============================================================================

-- rank-change requests (auto-raised at thresholds, or admin-forced)
create table if not exists rank_requests (
  id text primary key,
  user_id text references users(id),
  from_rank text,
  to_rank text,
  pieces numeric default 0,
  status text default 'pending',      -- 'pending' | 'approved' | 'rejected'
  created_at timestamptz default now(),
  resolved_at timestamptz
);

-- popup-seen marker on users (congrats shows once per rank)
alter table users add column if not exists rank_seen text;

-- rank config on shop_settings
alter table shop_settings add column if not exists rank_silver_pieces     integer default 1;
alter table shop_settings add column if not exists rank_gold_pieces       integer default 50;
alter table shop_settings add column if not exists rank_gold_deposit_pct  integer default 50;
alter table shop_settings add column if not exists instock_disc_gold_type text    default 'percent';
alter table shop_settings add column if not exists instock_disc_gold_value numeric default 0;
