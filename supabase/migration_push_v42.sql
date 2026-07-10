-- ============================================================================
-- Ryuma - v42: Web Push notification subscriptions.
-- Paste into the Supabase SQL Editor. Safe to re-run (idempotent).
--
-- One row per DEVICE that turned notifications on (a customer may hold several:
-- phone + desktop). Rows are written by their OWNER via the profile toggle and
-- read by the ADMIN session to send notifications (the admin browser posts the
-- target list to /api/push-send, which holds only the VAPID private key).
--
-- Depends on v20/v21 helpers: app_user_id(), is_app_admin().
-- ============================================================================

create table if not exists push_subscriptions (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  endpoint text not null,        -- browser push endpoint URL (unique per device)
  p256dh text not null,          -- browser-issued encryption key
  auth text not null,            -- browser-issued auth secret
  created_at timestamptz not null default now()
);
create unique index if not exists push_subscriptions_endpoint_idx on push_subscriptions(endpoint);
create index if not exists push_subscriptions_user_idx on push_subscriptions(user_id);

alter table push_subscriptions enable row level security;

-- a member manages their OWN devices; admin reads everything (to send) and may prune dead rows
drop policy if exists push_subscriptions_read on push_subscriptions;
create policy push_subscriptions_read on push_subscriptions for select
  using (user_id = app_user_id() or is_app_admin());

drop policy if exists push_subscriptions_insert on push_subscriptions;
create policy push_subscriptions_insert on push_subscriptions for insert
  with check (user_id = app_user_id() or is_app_admin());

drop policy if exists push_subscriptions_update on push_subscriptions;
create policy push_subscriptions_update on push_subscriptions for update
  using (user_id = app_user_id() or is_app_admin())
  with check (user_id = app_user_id() or is_app_admin());

drop policy if exists push_subscriptions_delete on push_subscriptions;
create policy push_subscriptions_delete on push_subscriptions for delete
  using (user_id = app_user_id() or is_app_admin());

-- self-check (optional):
-- select polname, cmd from pg_policies where tablename = 'push_subscriptions';
