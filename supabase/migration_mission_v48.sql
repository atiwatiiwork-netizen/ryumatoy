-- ============================================================================
-- Ryuma - v48: Event ภารกิจ (mission quest) submissions.
-- Paste into the Supabase SQL Editor. Safe to re-run (idempotent).
--
-- Customer completes 3 checks (has a pre-order ticket / installed to home screen /
-- bell on) and submits ONCE per event; admin reviews (+ optional proof screenshot)
-- and approves -> the reward coupon is granted in the ADMIN session.
--
-- RLS hardening:
--  - member INSERTS only their OWN submission and only with status='pending'
--    (can't self-approve -> can't self-trigger the reward)
--  - member READS only their own; admin reads all
--  - UPDATE / DELETE = admin only (approve/reject is an admin act)
-- Event config itself lives in app_config (key 'mission_event') -> no new columns.
-- ============================================================================

create table if not exists mission_submissions (
  id text primary key,
  event_key text not null default 'mission_event',
  user_id text not null references users(id) on delete cascade,
  status text not null default 'pending',   -- pending | approved | rejected
  proof_url text,                           -- screenshot fallback when installed_at wasn't stamped
  created_at timestamptz not null default now(),
  approved_at timestamptz
);
create index if not exists mission_submissions_user_idx on mission_submissions(user_id);
create index if not exists mission_submissions_status_idx on mission_submissions(status);

alter table mission_submissions enable row level security;

drop policy if exists mission_read on mission_submissions;
create policy mission_read on mission_submissions for select
  using (user_id = app_user_id() or is_app_admin());

drop policy if exists mission_insert on mission_submissions;
create policy mission_insert on mission_submissions for insert
  with check ((user_id = app_user_id() and status = 'pending') or is_app_admin());

drop policy if exists mission_update on mission_submissions;
create policy mission_update on mission_submissions for update
  using (is_app_admin())
  with check (is_app_admin());

drop policy if exists mission_delete on mission_submissions;
create policy mission_delete on mission_submissions for delete
  using (is_app_admin());

-- self-check (optional):
-- select column_name from information_schema.columns where table_name='mission_submissions';
