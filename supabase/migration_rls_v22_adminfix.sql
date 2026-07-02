-- ============================================================================
-- Ryuma — Phase 2 hardening: make admin/user resolution bulletproof under RLS.
-- Safe to re-run. Fixes the risk that an FB admin whose users.auth_id wasn't
-- backfilled (e.g. no facebook_id at v20 time) would log in but see NO data.
-- The FB admin's users.id already EQUALS their auth uid, so we also match by id.
-- ============================================================================

-- belt-and-suspenders: also backfill any admin/FB rows still missing auth_id
update users set auth_id = id::uuid
  where auth_id is null and id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and (facebook_id is not null or is_admin = true);

create or replace function app_user_id()
returns text language sql stable security definer set search_path = public as $$
  select id from users where auth_id = auth.uid() or id = auth.uid()::text limit 1
$$;

create or replace function is_app_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(
    (select is_admin from users where auth_id = auth.uid() or id = auth.uid()::text limit 1),
    false)
$$;
