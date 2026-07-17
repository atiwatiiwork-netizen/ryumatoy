-- ============================================================================
-- Ryuma - v49: sourcing memos (admin-only) — external sourcing deals from
-- Facebook chat / phone, jotted down so nothing is forgotten. NOT the in-app
-- sourcing_requests flow: these customers have no app account.
-- Paste into the Supabase SQL Editor. Safe to re-run (idempotent).
--
-- RLS: ADMIN ONLY for every operation (customers must never see these rows —
-- they contain other customers' names + FB links + prices).
-- ============================================================================

create table if not exists sourcing_memos (
  id text primary key,
  product_name text not null,
  image_url text,
  price int,                        -- agreed full price (baht)
  deposit int,                      -- deposit already collected
  qty int not null default 1,
  customer_name text not null,
  fb_link text,                     -- customer's Facebook link (jump back to the chat)
  transport text,                   -- truck | ship (rough ETA from started_at)
  started_at date not null,
  note text,
  status text not null default 'active',  -- active | done
  created_at timestamptz not null default now(),
  done_at timestamptz
);
create index if not exists sourcing_memos_status_idx on sourcing_memos(status);

alter table sourcing_memos enable row level security;

drop policy if exists sourcing_memos_read on sourcing_memos;
create policy sourcing_memos_read on sourcing_memos for select using (is_app_admin());

drop policy if exists sourcing_memos_insert on sourcing_memos;
create policy sourcing_memos_insert on sourcing_memos for insert with check (is_app_admin());

drop policy if exists sourcing_memos_update on sourcing_memos;
create policy sourcing_memos_update on sourcing_memos for update using (is_app_admin()) with check (is_app_admin());

drop policy if exists sourcing_memos_delete on sourcing_memos;
create policy sourcing_memos_delete on sourcing_memos for delete using (is_app_admin());

-- self-check (optional):
-- select column_name from information_schema.columns where table_name='sourcing_memos';
