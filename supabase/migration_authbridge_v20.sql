-- ============================================================================
-- Ryuma — Phase 1: Supabase Auth bridge (prep for RLS). Paste into SQL Editor.
-- Safe to re-run (idempotent). RLS is STILL OFF after this migration — this only
-- gives phone+PIN customers a real Supabase Auth session (JWT) so that RLS in the
-- next migration (v21) can key on auth.uid(). The app keeps working exactly as
-- before until v21 flips RLS on.
--
-- Customer login stays "phone + 6-digit PIN". Behind the scenes:
--   account email    = {digits-of-phone}@ryuma.local   (synthetic, never emailed)
--   account password = the 6-digit PIN
-- Supabase Auth stores the password (bcrypt) in auth.users. The legacy
-- user_secrets/ryuma_login path is KEPT so unmigrated users can still log in and
-- get lazily migrated by the client on their next successful login.
--
-- EXTERNAL SETUP REQUIRED before customers can sign up/log in:
--   Supabase Dashboard → Authentication → Providers → Email → turn OFF
--   "Confirm email" (we use synthetic emails that can't receive a confirmation).
-- ============================================================================

create extension if not exists pgcrypto;

-- ── link an app user (users.id = TEXT) to a Supabase Auth uid (uuid) ──
alter table users add column if not exists auth_id  uuid unique;
alter table users add column if not exists is_admin boolean default false;

-- Backfill: the Facebook admin's users.id already equals their auth uid.
update users set auth_id = id::uuid
  where auth_id is null and facebook_id is not null and id ~ '^[0-9a-f-]{36}$';

-- Mark the owner as admin (owner logs in via Facebook; id = FB auth uid).
update users set is_admin = true where id = '08809e6a-cfd1-4d57-a8f1-06a133bd2df6';

-- ── helpers used by RLS policies in v21 (defined now, harmless until then) ──
-- current app user id (TEXT) for the logged-in Supabase session, or null
create or replace function app_user_id()
returns text language sql stable security definer set search_path = public as $$
  select id from users where auth_id = auth.uid() limit 1
$$;

-- is the current Supabase session an admin?
create or replace function is_app_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select is_admin from users where auth_id = auth.uid() limit 1), false)
$$;

grant execute on function app_user_id()  to anon, authenticated;
grant execute on function is_app_admin() to anon, authenticated;

-- ── signup v2: the client creates the Supabase Auth account first (auth.signUp),
--    then calls this to create the linked app-users row (approved=false). No PIN
--    is stored here anymore — Supabase Auth owns the password. ──
create or replace function ryuma_signup_v2(p_name text, p_phone text, p_fb text, p_auth_id uuid)
returns json language plpgsql security definer set search_path = public, extensions as $$
declare v_id text;
begin
  if exists (select 1 from users where phone = p_phone) then return json_build_object('error','phone_taken'); end if;
  if coalesce(p_fb,'') <> '' and exists (select 1 from users where fb_link = p_fb) then return json_build_object('error','fb_taken'); end if;
  v_id := gen_random_uuid()::text;
  insert into users(id, display_name, phone, fb_link, rank, rank_seen, total_spent, preferred_lang, approved, pin_reset, auth_id)
    values (v_id, p_name, p_phone, nullif(p_fb,''), 'bronze', 'bronze', 0, 'th', false, false, p_auth_id);
  return json_build_object('ok', true, 'user_id', v_id);
end $$;

-- ── link an existing (legacy) app user to a freshly created Supabase Auth uid.
--    Used by the client's lazy migration: legacy PIN verified → auth account made
--    with the same PIN → link it here so future logins use Supabase Auth. ──
create or replace function ryuma_link_auth(p_user_id text, p_auth_id uuid)
returns json language plpgsql security definer set search_path = public, extensions as $$
begin
  update users set auth_id = p_auth_id where id = p_user_id;
  return json_build_object('ok', true);
end $$;

-- ── forgot-PIN: also reset the Supabase Auth password (kept in sync with legacy
--    user_secrets). Still gated on users.pin_reset (admin must allow it first). ──
create or replace function ryuma_set_new_pin(p_phone text, p_new_pin text)
returns json language plpgsql security definer set search_path = public, extensions as $$
declare v_user users;
begin
  if length(coalesce(p_new_pin,'')) <> 6 then return json_build_object('error','bad_pin'); end if;
  select * into v_user from users where phone = p_phone;
  if not found then return json_build_object('error','not_found'); end if;
  if not coalesce(v_user.pin_reset, false) then return json_build_object('error','not_allowed'); end if;
  update user_secrets set pin_hash = crypt(p_new_pin, gen_salt('bf')), attempts = 0, locked_until = null where user_id = v_user.id;
  if v_user.auth_id is not null then
    update auth.users set encrypted_password = crypt(p_new_pin, gen_salt('bf')), updated_at = now() where id = v_user.auth_id;
  end if;
  update users set pin_reset = false where id = v_user.id;
  return json_build_object('ok', true);
end $$;

grant execute on function ryuma_signup_v2(text,text,text,uuid) to anon, authenticated;
grant execute on function ryuma_link_auth(text,uuid)           to anon, authenticated;
grant execute on function ryuma_set_new_pin(text,text)         to anon, authenticated;
