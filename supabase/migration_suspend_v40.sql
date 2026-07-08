-- ============================================================================
-- Ryuma - v40: SUSPEND MEMBER (anti-spy). Paste into SQL Editor. Safe to re-run.
--
-- A dormant new member (approved 30+ days, no ticket, no order) can be SUSPENDED:
-- reversible, keeps their data, but is_app_approved() goes false -> the members-only
-- catalog RLS (v33) hides every product/price from them until unsuspended.
-- ============================================================================

-- 1. flag
alter table users add column if not exists suspended boolean default false;

-- 2. approved gate now also requires NOT suspended (v33 catalog policies call this)
create or replace function is_app_approved() returns boolean
  language sql stable security definer set search_path = public as $$
  select is_app_admin() or exists (
    select 1 from users u
    where u.id = app_user_id()
      and u.approved is not false
      and coalesce(u.suspended, false) = false
  );
$$;

-- 3. protect the flag: a customer must not un-suspend (or suspend) themselves
create or replace function guard_user_columns()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if is_app_admin() then return new; end if;
  if new.id          is distinct from old.id
     or new.auth_id     is distinct from old.auth_id
     or new.is_admin    is distinct from old.is_admin
     or new.approved    is distinct from old.approved
     or new.suspended   is distinct from old.suspended
     or new.rank        is distinct from old.rank
     or new.total_spent is distinct from old.total_spent
     or new.member_code is distinct from old.member_code
     or new.phone       is distinct from old.phone
     or new.fb_link     is distinct from old.fb_link
     or new.pin_reset   is distinct from old.pin_reset
  then
    raise exception 'ryuma: not allowed to modify protected user columns';
  end if;
  return new;
end $$;
drop trigger if exists trg_guard_user on users;
create trigger trg_guard_user before update on users for each row execute function guard_user_columns();

-- self-check (optional):
-- select column_name from information_schema.columns where table_name='users' and column_name='suspended';
