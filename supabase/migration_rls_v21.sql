-- ============================================================================
-- Ryuma — Phase 2: Row Level Security (the actual data-isolation fix).
-- RUN THIS ONLY AFTER migration_authbridge_v20 is applied AND Phase-1 login/signup
-- have been verified working (customers must already get real Supabase Auth JWTs,
-- otherwise enabling RLS will white-screen the live app).
--
-- Model:
--   • Public catalog  → anyone may READ; only admins may WRITE.
--   • Private data     → each customer sees/writes ONLY their own rows; admins all.
--   • Helpers app_user_id() / is_app_admin() come from v20 (SECURITY DEFINER, so
--     they bypass RLS when they read `users` — no recursion).
--
-- ROLLBACK (if anything breaks in production, run to instantly restore old behavior):
--   do $$ declare t text; begin
--     foreach t in array array['users','categories','manufacturers','franchises','series',
--       'products','product_variants','product_batches','stock_additions','coupons',
--       'payment_accounts','shop_settings','orders','order_items','preorder_tickets',
--       'remaining_payments','rank_requests','ticket_transfers','rank_tiers']
--     loop execute format('alter table %I disable row level security', t); end loop; end $$;
-- ============================================================================

-- ── guard: non-admins may only edit profile fields on their own users row ──
-- (prevents a customer from self-escalating is_admin/approved/rank/etc.)
create or replace function guard_user_columns()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if is_app_admin() then return new; end if;
  if new.id          is distinct from old.id
     or new.auth_id     is distinct from old.auth_id
     or new.is_admin    is distinct from old.is_admin
     or new.approved    is distinct from old.approved
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

-- ── helper to (re)apply a public-read + admin-write policy pair on a table ──
do $$
declare
  pub text[] := array['rank_tiers','categories','manufacturers','franchises','series',
    'products','product_variants','product_batches','stock_additions','coupons',
    'payment_accounts','shop_settings'];
  t text;
begin
  foreach t in array pub loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', t||'_read', t);
    execute format('drop policy if exists %I on %I', t||'_admin', t);
    -- anyone may read the catalog
    execute format('create policy %I on %I for select using (true)', t||'_read', t);
    -- only admins may insert/update/delete
    execute format('create policy %I on %I for all using (is_app_admin()) with check (is_app_admin())', t||'_admin', t);
  end loop;
end $$;

-- ── private tables: own-rows-or-admin (one policy governs select + write) ──

-- users: your own row (matched by auth_id) or admin. Column guard above blocks escalation.
alter table users enable row level security;
drop policy if exists users_own on users;
create policy users_own on users for all
  using (auth_id = auth.uid() or is_app_admin())
  with check (auth_id = auth.uid() or is_app_admin());

-- orders
alter table orders enable row level security;
drop policy if exists orders_own on orders;
create policy orders_own on orders for all
  using (user_id = app_user_id() or is_app_admin())
  with check (user_id = app_user_id() or is_app_admin());

-- order_items: gated through the parent order's ownership
alter table order_items enable row level security;
drop policy if exists order_items_own on order_items;
create policy order_items_own on order_items for all
  using (is_app_admin() or exists (select 1 from orders o where o.id = order_items.order_id and o.user_id = app_user_id()))
  with check (is_app_admin() or exists (select 1 from orders o where o.id = order_items.order_id and o.user_id = app_user_id()));

-- preorder_tickets: the owner (or original buyer) or admin
alter table preorder_tickets enable row level security;
drop policy if exists tickets_own on preorder_tickets;
create policy tickets_own on preorder_tickets for all
  using (owner_id = app_user_id() or original_buyer_id = app_user_id() or is_app_admin())
  with check (owner_id = app_user_id() or original_buyer_id = app_user_id() or is_app_admin());

-- remaining_payments
alter table remaining_payments enable row level security;
drop policy if exists remaining_own on remaining_payments;
create policy remaining_own on remaining_payments for all
  using (user_id = app_user_id() or is_app_admin())
  with check (user_id = app_user_id() or is_app_admin());

-- rank_requests
alter table rank_requests enable row level security;
drop policy if exists rank_req_own on rank_requests;
create policy rank_req_own on rank_requests for all
  using (user_id = app_user_id() or is_app_admin())
  with check (user_id = app_user_id() or is_app_admin());

-- ticket_transfers: the seller, the buyer, or admin
alter table ticket_transfers enable row level security;
drop policy if exists transfers_own on ticket_transfers;
create policy transfers_own on ticket_transfers for all
  using (from_user_id = app_user_id() or to_user_id = app_user_id() or is_app_admin())
  with check (from_user_id = app_user_id() or to_user_id = app_user_id() or is_app_admin());

-- stock_reservations already has RLS (public read, writes via SECURITY DEFINER RPCs) — left as-is.
-- user_secrets already has RLS with no anon policy (PIN hashes stay locked) — left as-is.
