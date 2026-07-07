-- ============================================================================
-- Ryuma - v39: fix CUSTOMER coupon redemption. Paste into SQL Editor. Safe to re-run.
--
-- The app persists a redeemed coupon by upserting the grant row (syncTable uses
-- .upsert(), i.e. INSERT ... ON CONFLICT). Postgres applies the INSERT WITH CHECK
-- policy to that row even when it resolves to an UPDATE -- and v38's insert policy
-- was admin-only, so a customer marking their own coupon "used" was rejected by RLS
-- (the whole save aborted). Fix: let an owner write their OWN grant rows, but a
-- guard trigger forbids a non-admin from creating/holding an ACTIVE grant, so a
-- customer still cannot self-grant a usable coupon.
-- Depends on app_user_id(), is_app_admin() (v20/v21).
-- ============================================================================

drop policy if exists coupon_grants_insert on coupon_grants;
create policy coupon_grants_insert on coupon_grants for insert
  with check (user_id = app_user_id() or is_app_admin());

create or replace function ryuma_guard_coupon_grant() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  -- only admins may issue or hold an ACTIVE grant; a customer may only flip their
  -- own grant to 'used' / 'revoked' (redeem). blocks self-granting a usable coupon.
  if not is_app_admin() and coalesce(new.status, 'active') = 'active' then
    raise exception 'coupon grants can only be issued by an admin';
  end if;
  return new;
end $$;

drop trigger if exists coupon_grants_guard on coupon_grants;
create trigger coupon_grants_guard before insert or update on coupon_grants
  for each row execute function ryuma_guard_coupon_grant();

-- self-check (optional):
-- select polname, cmd from pg_policies where tablename = 'coupon_grants';
