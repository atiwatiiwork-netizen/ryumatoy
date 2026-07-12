-- ============================================================================
-- Ryuma - v44: ระบบหาของ (sourcing requests) + generic app_config.
-- Paste into the Supabase SQL Editor. Safe to re-run (idempotent).
--
-- sourcing_requests: a customer's "find this for me" ticket. Status flow:
--   requested -> quoted (5-day TTL) -> paid -> working   |  requested -> unavailable (5-day TTL)
--   expired rows stay as history. Fulfillment (working) creates a hidden
--   product + closed batch + real ticket from the ADMIN session.
-- Guard trigger: a NON-ADMIN may only (a) insert their own row as 'requested'
-- with no quote fields, (b) flip their own 'quoted' row to 'paid' adding the
-- slip, (c) mark their own row 'expired'. Everything else is admin-only.
-- app_config: generic key->jsonb (first use: sourcing transport ETA ranges) —
-- kept OFF shop_settings so its fixed column list never breaks saves.
--
-- Depends on v20/v21 helpers: app_user_id(), is_app_admin(), is_app_approved().
-- ============================================================================

create table if not exists sourcing_requests (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  maker_id text,
  maker_name text not null,
  franchise_id text,
  franchise_name text not null,
  character_name text not null,
  qty int not null default 1,
  images text[] not null default '{}',
  note text,
  status text not null default 'requested',  -- requested|quoted|unavailable|paid|working|expired
  created_at timestamptz not null default now(),
  price int,
  deposit int,
  transport text,                            -- truck | ship
  quoted_at timestamptz,
  expires_at timestamptz,
  slip_url text,
  paid_at timestamptz,
  approved_at timestamptz,
  product_id text,
  resent_from text
);
create index if not exists sourcing_requests_user_idx on sourcing_requests(user_id);
create index if not exists sourcing_requests_status_idx on sourcing_requests(status);

alter table sourcing_requests enable row level security;

drop policy if exists sourcing_read on sourcing_requests;
create policy sourcing_read on sourcing_requests for select
  using (user_id = app_user_id() or is_app_admin());

drop policy if exists sourcing_insert on sourcing_requests;
create policy sourcing_insert on sourcing_requests for insert
  with check (user_id = app_user_id() or is_app_admin());

drop policy if exists sourcing_update on sourcing_requests;
create policy sourcing_update on sourcing_requests for update
  using (user_id = app_user_id() or is_app_admin())
  with check (user_id = app_user_id() or is_app_admin());

drop policy if exists sourcing_delete on sourcing_requests;
create policy sourcing_delete on sourcing_requests for delete
  using (is_app_admin());

-- guard: customers cannot self-quote / self-approve / touch money fields
create or replace function ryuma_guard_sourcing() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  if is_app_admin() then return new; end if;
  if tg_op = 'INSERT' then
    if new.status <> 'requested' or new.price is not null or new.deposit is not null
       or new.approved_at is not null or new.product_id is not null then
      raise exception 'sourcing requests can only be filed as requested';
    end if;
    return new;
  end if;
  -- UPDATE by owner: allow quoted->paid (slip attach) and ->expired; quote fields must not change
  if new.price is distinct from old.price or new.deposit is distinct from old.deposit
     or new.transport is distinct from old.transport or new.expires_at is distinct from old.expires_at
     or new.approved_at is distinct from old.approved_at or new.product_id is distinct from old.product_id then
    raise exception 'quote fields are admin-only';
  end if;
  if new.status is distinct from old.status
     and not (old.status = 'quoted' and new.status = 'paid')
     and not (new.status = 'expired' and old.status in ('quoted','unavailable')) then
    raise exception 'invalid status change';
  end if;
  return new;
end $$;

drop trigger if exists sourcing_guard on sourcing_requests;
create trigger sourcing_guard before insert or update on sourcing_requests
  for each row execute function ryuma_guard_sourcing();

-- generic config
create table if not exists app_config (
  key text primary key,
  value jsonb not null default '{}'::jsonb
);
alter table app_config enable row level security;

drop policy if exists app_config_read on app_config;
create policy app_config_read on app_config for select
  using (is_app_approved() or is_app_admin());

drop policy if exists app_config_admin on app_config;
create policy app_config_admin on app_config for all
  using (is_app_admin()) with check (is_app_admin());

-- widen push_config read to approved members: customer-side senders (e.g. a new sourcing request
-- pinging the admin) must SEE the admin's kill-switches for them to take effect. Values are only
-- {key, enabled} booleans - safe to expose to members.
drop policy if exists push_config_read on push_config;
create policy push_config_read on push_config for select
  using (is_app_approved() or is_app_admin());

-- self-check (optional):
-- select polname, cmd from pg_policies where tablename in ('sourcing_requests','app_config');
