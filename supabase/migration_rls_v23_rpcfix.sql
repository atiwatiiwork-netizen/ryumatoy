-- ============================================================================
-- Ryuma — Phase 2 FIX (run this; it supersedes v22). Safe to re-run.
-- The v21 guard trigger blocked legitimate SECURITY DEFINER RPCs that modify
-- protected user columns (they run with auth.uid()=the caller/none, not admin):
--   • ryuma_link_auth  → sets users.auth_id (customer lazy-migration on 1st login)
--   • ryuma_set_new_pin→ sets users.pin_reset (forgot-PIN)
-- Fix: those RPCs flag the transaction as trusted; the trigger allows admin OR a
-- trusted RPC, while still blocking a customer's direct self-escalation.
-- Also folds in the v22 admin hardening (recognize FB admin by id) + re-backfill.
-- ============================================================================

-- ── admin hardening (from v22): match FB admin by id too, re-backfill auth_id ──
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

-- ── trigger: allow admins OR our trusted SECURITY DEFINER RPCs; block customers ──
create or replace function guard_user_columns()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if is_app_admin() or current_setting('ryuma.trusted', true) = 'on' then return new; end if;
  if new.id is distinct from old.id
     or new.auth_id     is distinct from old.auth_id
     or new.is_admin    is distinct from old.is_admin
     or new.approved    is distinct from old.approved
     or new.rank        is distinct from old.rank
     or new.total_spent is distinct from old.total_spent
     or new.member_code is distinct from old.member_code
     or new.phone       is distinct from old.phone
     or new.fb_link     is distinct from old.fb_link
     or new.pin_reset   is distinct from old.pin_reset
  then raise exception 'ryuma: not allowed to modify protected user columns'; end if;
  return new;
end $$;
drop trigger if exists trg_guard_user on users;
create trigger trg_guard_user before update on users for each row execute function guard_user_columns();

-- ── ryuma_approve: make it admin-only (defense-in-depth); admin session passes trigger ──
create or replace function ryuma_approve(p_user_id text)
returns json language plpgsql security definer set search_path = public, extensions as $$
declare v_code text;
begin
  if not is_app_admin() then return json_build_object('error','not_admin'); end if;
  select member_code into v_code from users where id = p_user_id;
  if v_code is null then v_code := 'RYU-' || lpad(nextval('member_seq')::text, 4, '0'); end if;
  update users set approved = true, member_code = v_code where id = p_user_id;
  return json_build_object('ok', true, 'member_code', v_code);
end $$;

-- ── ryuma_link_auth: flag trusted; only link an as-yet-unlinked row (anti-hijack) ──
create or replace function ryuma_link_auth(p_user_id text, p_auth_id uuid)
returns json language plpgsql security definer set search_path = public, extensions as $$
begin
  perform set_config('ryuma.trusted', 'on', true);
  update users set auth_id = p_auth_id where id = p_user_id and auth_id is null;
  return json_build_object('ok', true);
end $$;

-- ── ryuma_set_new_pin: flag trusted before touching users.pin_reset ──
create or replace function ryuma_set_new_pin(p_phone text, p_new_pin text)
returns json language plpgsql security definer set search_path = public, extensions as $$
declare v_user users;
begin
  if length(coalesce(p_new_pin,'')) <> 6 then return json_build_object('error','bad_pin'); end if;
  select * into v_user from users where phone = p_phone;
  if not found then return json_build_object('error','not_found'); end if;
  if not coalesce(v_user.pin_reset, false) then return json_build_object('error','not_allowed'); end if;
  perform set_config('ryuma.trusted', 'on', true);
  update user_secrets set pin_hash = crypt(p_new_pin, gen_salt('bf')), attempts = 0, locked_until = null where user_id = v_user.id;
  if v_user.auth_id is not null then
    update auth.users set encrypted_password = crypt(p_new_pin, gen_salt('bf')), updated_at = now() where id = v_user.auth_id;
  end if;
  update users set pin_reset = false where id = v_user.id;
  return json_build_object('ok', true);
end $$;

grant execute on function ryuma_approve(text)          to anon, authenticated;
grant execute on function ryuma_link_auth(text,uuid)   to anon, authenticated;
grant execute on function ryuma_set_new_pin(text,text) to anon, authenticated;
