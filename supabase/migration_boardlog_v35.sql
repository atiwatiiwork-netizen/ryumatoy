-- ============================================================================
-- Ryuma — v35: board close/production history log. Paste into SQL Editor. Safe to re-run.
-- Immutable snapshot written when a board is closed + its round sent to production:
-- date, board, and per-product booked vs final(ordered) vs surplus. Admin-only.
-- ============================================================================
create table if not exists board_close_logs (
  id text primary key,
  board_id text,
  board_title text,
  maker_id text,
  closed_at timestamptz,
  lines jsonb default '[]'::jsonb
);

alter table board_close_logs enable row level security;
drop policy if exists board_close_logs_read on board_close_logs;
create policy board_close_logs_read on board_close_logs for select using (is_app_admin());
drop policy if exists board_close_logs_admin on board_close_logs;
create policy board_close_logs_admin on board_close_logs for all using (is_app_admin()) with check (is_app_admin());
