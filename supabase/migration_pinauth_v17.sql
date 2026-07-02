-- ============================================================================
-- Ryuma — phone + 6-digit PIN auth (server-side, secure). Paste into SQL Editor.
-- Safe to re-run. PIN hashes live in a locked table (user_secrets, RLS on) and are
-- ONLY touched by SECURITY DEFINER functions — the browser never sees them.
-- Login is rate-limited (lock 15 min after 5 wrong PINs). users stays open (RLS off).
-- ============================================================================

create extension if not exists pgcrypto;

alter table users add column if not exists member_code text;
alter table users add column if not exists fb_link     text;
alter table users add column if not exists pin_reset    boolean default false;

-- secrets table — locked down: no anon policies → client cannot read/write directly
create table if not exists user_secrets (
  user_id      text primary key references users(id) on delete cascade,
  pin_hash     text not null,
  attempts     int default 0,
  locked_until timestamptz
);
alter table user_secrets enable row level security;

create sequence if not exists member_seq start 1;

-- ── signup: create a PENDING user + hashed PIN. Rejects duplicate phone/FB. ──
create or replace function ryuma_signup(p_name text, p_phone text, p_fb text, p_pin text)
returns json language plpgsql security definer set search_path = public as $$
declare v_id text;
begin
  if length(coalesce(p_pin,'')) <> 6 then return json_build_object('error','bad_pin'); end if;
  if exists (select 1 from users where phone = p_phone) then return json_build_object('error','phone_taken'); end if;
  if coalesce(p_fb,'') <> '' and exists (select 1 from users where fb_link = p_fb) then return json_build_object('error','fb_taken'); end if;
  v_id := gen_random_uuid()::text;
  insert into users(id, display_name, phone, fb_link, rank, rank_seen, total_spent, preferred_lang, approved, pin_reset)
    values (v_id, p_name, p_phone, nullif(p_fb,''), 'bronze', 'bronze', 0, 'th', false, false);
  insert into user_secrets(user_id, pin_hash) values (v_id, crypt(p_pin, gen_salt('bf')));
  return json_build_object('ok', true, 'user_id', v_id);
end $$;

-- ── login: verify PIN with lockout ──
create or replace function ryuma_login(p_phone text, p_pin text)
returns json language plpgsql security definer set search_path = public as $$
declare v_user users; v_sec user_secrets;
begin
  select * into v_user from users where phone = p_phone;
  if not found then return json_build_object('error','not_found'); end if;
  select * into v_sec from user_secrets where user_id = v_user.id;
  if not found then return json_build_object('error','not_found'); end if;
  if v_sec.locked_until is not null and v_sec.locked_until > now() then
    return json_build_object('error','locked','until', v_sec.locked_until);
  end if;
  if v_sec.pin_hash = crypt(p_pin, v_sec.pin_hash) then
    update user_secrets set attempts = 0, locked_until = null where user_id = v_user.id;
    return json_build_object('ok', true, 'user_id', v_user.id);
  else
    update user_secrets
      set attempts = attempts + 1,
          locked_until = case when attempts + 1 >= 5 then now() + interval '15 minutes' else null end
      where user_id = v_user.id;
    return json_build_object('error','wrong_pin');
  end if;
end $$;

-- ── admin approve → mark approved + assign RYU-000x (sequential) ──
create or replace function ryuma_approve(p_user_id text)
returns json language plpgsql security definer set search_path = public as $$
declare v_code text;
begin
  select member_code into v_code from users where id = p_user_id;
  if v_code is null then v_code := 'RYU-' || lpad(nextval('member_seq')::text, 4, '0'); end if;
  update users set approved = true, member_code = v_code where id = p_user_id;
  return json_build_object('ok', true, 'member_code', v_code);
end $$;

-- ── forgot PIN: user sets a new PIN, allowed only after admin set users.pin_reset ──
create or replace function ryuma_set_new_pin(p_phone text, p_new_pin text)
returns json language plpgsql security definer set search_path = public as $$
declare v_user users;
begin
  if length(coalesce(p_new_pin,'')) <> 6 then return json_build_object('error','bad_pin'); end if;
  select * into v_user from users where phone = p_phone;
  if not found then return json_build_object('error','not_found'); end if;
  if not coalesce(v_user.pin_reset, false) then return json_build_object('error','not_allowed'); end if;
  update user_secrets set pin_hash = crypt(p_new_pin, gen_salt('bf')), attempts = 0, locked_until = null where user_id = v_user.id;
  update users set pin_reset = false where id = v_user.id;
  return json_build_object('ok', true);
end $$;

grant execute on function ryuma_signup(text,text,text,text) to anon, authenticated;
grant execute on function ryuma_login(text,text)            to anon, authenticated;
grant execute on function ryuma_approve(text)               to anon, authenticated;
grant execute on function ryuma_set_new_pin(text,text)      to anon, authenticated;
