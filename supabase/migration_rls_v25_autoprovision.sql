-- ============================================================================
-- Ryuma — Phase 2 self-heal v2 (run this; supersedes v24's function). Safe to re-run.
-- Some sessions have a valid Supabase Auth account but NO users row at all — the
-- signUp succeeded but ryuma_signup_v2 didn't (interrupted/failed), leaving an
-- "orphan" auth account. Under RLS that session sees 0 rows → app hangs on
-- "loading account" and link-by-phone finds nothing (no_match). Fix: ryuma_link_self
-- now AUTO-PROVISIONS a pending users row for the phone in the email when none exists,
-- linked to the session — so any valid session always resolves. Admin then reviews
-- the new pending member in the approval queue as usual.
-- (The client already calls ryuma_link_self on load — no app deploy needed.)
-- ============================================================================

create or replace function ryuma_link_self()
returns json language plpgsql security definer set search_path = public, extensions as $$
declare v_uid uuid := auth.uid(); v_email text; v_phone text; v_id text;
begin
  if v_uid is null then return json_build_object('error','no_session'); end if;
  -- already linked → nothing to do
  if exists (select 1 from users where auth_id = v_uid) then return json_build_object('ok', true, 'already', true); end if;
  select email into v_email from auth.users where id = v_uid;
  if v_email is null then return json_build_object('error','no_email'); end if;
  v_phone := split_part(v_email, '@', 1);   -- synthetic email is {phone}@ryuma.local

  perform set_config('ryuma.trusted', 'on', true);
  -- (a) link an existing unlinked row for this phone
  update users set auth_id = v_uid where phone = v_phone and auth_id is null returning id into v_id;
  if v_id is not null then return json_build_object('ok', true, 'user_id', v_id, 'linked', true); end if;

  -- (b) no users row for this phone (orphan auth account) → provision a pending one
  v_id := gen_random_uuid()::text;
  insert into users(id, display_name, phone, rank, rank_seen, total_spent, preferred_lang, approved, pin_reset, auth_id)
    values (v_id, 'ลูกค้า ' || v_phone, v_phone, 'bronze', 'bronze', 0, 'th', false, false, v_uid);
  return json_build_object('ok', true, 'user_id', v_id, 'created', true);
end $$;

grant execute on function ryuma_link_self() to anon, authenticated;
