-- ============================================================================
-- Ryuma — Phase 2 self-heal (run this). Safe to re-run.
-- Fixes users who logged in during the window when RLS (v21) was on but v23 hadn't
-- been applied yet: their Supabase Auth account was created but ryuma_link_auth was
-- blocked by the guard trigger, so users.auth_id stayed NULL. Now they have a valid
-- session but RLS can't see their own row (policy keys on auth_id) → app stuck on
-- "loading account" forever. This RPC links the calling session to its users row by
-- the phone embedded in the synthetic email ({phone}@ryuma.local), only when unlinked.
-- The client calls it automatically when a logged-in session fails to resolve.
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
  update users set auth_id = v_uid where phone = v_phone and auth_id is null returning id into v_id;
  if v_id is null then return json_build_object('error','no_match'); end if;
  return json_build_object('ok', true, 'user_id', v_id);
end $$;

grant execute on function ryuma_link_self() to anon, authenticated;
