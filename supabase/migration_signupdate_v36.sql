-- ============================================================================
-- Ryuma — v36: signup date on users. Paste into SQL Editor. Safe to re-run.
-- New signups get created_at = now() (the RPC insert omits it → DB default).
-- Backfills existing members' created_at from their auth account creation time
-- (the real signup moment) where linked.
-- ============================================================================
alter table users add column if not exists created_at timestamptz default now();

update users u
  set created_at = a.created_at
  from auth.users a
  where u.auth_id = a.id;
