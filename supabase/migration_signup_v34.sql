-- ============================================================================
-- Ryuma — v34: make ryuma_signup_v2 idempotent (fixes lost name + FB at signup).
-- Paste into SQL Editor. Safe to re-run.
--
-- BUG: on signup, onAuthStateChange fires adopt() which calls ryuma_link_self →
-- that AUTO-PROVISIONS a "ลูกค้า {phone}" row (no name/FB). ryuma_signup_v2 then
-- ran a beat later, saw the phone already taken, and returned phone_taken — so the
-- real display name + Facebook link were never written.
--
-- FIX: if a row for this phone already exists AND belongs to the SAME auth account
-- (i.e. the freshly auto-provisioned one), UPDATE its name + FB instead of failing.
-- The function is SECURITY DEFINER + sets ryuma.trusted, so it may write the
-- guard-protected columns. A row owned by a DIFFERENT auth account is still taken.
-- (Client also guards adopt() during signup; this is the deterministic backstop.)
-- ============================================================================
create or replace function ryuma_signup_v2(p_name text, p_phone text, p_fb text, p_auth_id uuid)
returns json language plpgsql security definer set search_path = public, extensions as $$
declare v_id text; v_existing_auth uuid; v_exists boolean;
begin
  perform set_config('ryuma.trusted', 'on', true);

  -- FB uniqueness — ignore a row that belongs to this same auth account
  if coalesce(p_fb,'') <> '' and exists (
    select 1 from users where fb_link = p_fb and auth_id is distinct from p_auth_id
  ) then
    return json_build_object('error','fb_taken');
  end if;

  select auth_id, true into v_existing_auth, v_exists from users where phone = p_phone;
  if v_exists then
    if v_existing_auth is not distinct from p_auth_id then
      -- our own (auto-provisioned) row → backfill the real name + FB
      update users
        set display_name = p_name, fb_link = nullif(p_fb,''), auth_id = p_auth_id
        where phone = p_phone
        returning id into v_id;
      return json_build_object('ok', true, 'user_id', v_id, 'updated', true);
    end if;
    return json_build_object('error','phone_taken'); -- someone else's phone
  end if;

  v_id := gen_random_uuid()::text;
  insert into users(id, display_name, phone, fb_link, rank, rank_seen, total_spent, preferred_lang, approved, pin_reset, auth_id)
    values (v_id, p_name, p_phone, nullif(p_fb,''), 'bronze', 'bronze', 0, 'th', false, false, p_auth_id);
  return json_build_object('ok', true, 'user_id', v_id);
end $$;

grant execute on function ryuma_signup_v2(text, text, text, uuid) to anon, authenticated;
