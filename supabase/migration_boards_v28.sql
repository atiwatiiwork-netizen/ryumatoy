-- ============================================================================
-- Ryuma — Closing pre-order boards (กระดานปิดพรี). Paste into SQL Editor. Safe to re-run.
-- One board = ONE maker (never mixed). A board is a poster image + the products whose
-- board_id points to it. Closing a board sends its products to production.
-- RLS: boards are public-read, admin-write (same pattern as the catalog).
-- ============================================================================

create table if not exists preorder_boards (
  id         text primary key,
  maker_id   text references manufacturers(id),
  title      text not null,
  poster_url text,
  note       text,
  status     text not null default 'open',      -- 'open' (กำลังปิดพรี) | 'closed'
  created_at timestamptz default now(),
  closed_at  timestamptz
);

alter table products add column if not exists board_id   text references preorder_boards(id) on delete set null;
alter table products add column if not exists maker_code text;

-- RLS: anyone reads, only admins write (helpers is_app_admin() from v20/v23)
alter table preorder_boards enable row level security;
drop policy if exists preorder_boards_read  on preorder_boards;
drop policy if exists preorder_boards_admin on preorder_boards;
create policy preorder_boards_read  on preorder_boards for select using (true);
create policy preorder_boards_admin on preorder_boards for all using (is_app_admin()) with check (is_app_admin());
