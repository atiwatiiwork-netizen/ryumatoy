-- ============================================================================
-- Ryuma - v43: push notification preferences + admin trigger config.
-- Paste into the Supabase SQL Editor. Safe to re-run (idempotent).
--
-- push_prefs  : one row per CUSTOMER who narrowed their new-product broadcasts
--               (maker_ids / franchise_ids; absent row or empty array = all).
--               Written by the owner via the profile toggle, read by the admin
--               session when sending new-product pushes.
-- push_config : admin kill-switch per push trigger (Push Control page).
--               Missing key = enabled. Admin-only writes.
--
-- Depends on v20/v21 helpers: app_user_id(), is_app_admin().
-- ============================================================================

create table if not exists push_prefs (
  user_id text primary key references users(id) on delete cascade,
  maker_ids text[] not null default '{}',      -- empty = every maker
  franchise_ids text[] not null default '{}',  -- empty = every franchise
  updated_at timestamptz not null default now()
);

alter table push_prefs enable row level security;

drop policy if exists push_prefs_read on push_prefs;
create policy push_prefs_read on push_prefs for select
  using (user_id = app_user_id() or is_app_admin());

drop policy if exists push_prefs_write on push_prefs;
create policy push_prefs_write on push_prefs for all
  using (user_id = app_user_id() or is_app_admin())
  with check (user_id = app_user_id() or is_app_admin());

create table if not exists push_config (
  key text primary key,        -- trigger id, e.g. 'new_preorder', 'parcel'
  enabled boolean not null default true
);

alter table push_config enable row level security;

-- only the admin session reads/writes trigger switches (senders run as admin)
drop policy if exists push_config_read on push_config;
create policy push_config_read on push_config for select
  using (is_app_admin());

drop policy if exists push_config_admin on push_config;
create policy push_config_admin on push_config for all
  using (is_app_admin()) with check (is_app_admin());

-- self-check (optional):
-- select polname, cmd from pg_policies where tablename in ('push_prefs','push_config');
