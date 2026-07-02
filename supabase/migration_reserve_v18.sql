-- ============================================================================
-- Ryuma — stock reservation with 15-min hold (atomic, oversell-proof). SQL Editor.
-- available = total_stock − held, where held = active(unexpired) + paid + confirmed.
-- Reserve is serialized per product/batch via advisory lock → no oversell even when
-- many buyers click at the exact same time. Expiry is LAZY (no cron): an expired
-- 'active' hold simply stops counting. Slip submitted → 'paid' (stops the timer).
-- ============================================================================

create table if not exists stock_reservations (
  id             text primary key default gen_random_uuid()::text,
  product_id     text,
  batch_id       text,
  user_id        text,
  order_id       text,
  qty            int  not null default 1,
  status         text not null default 'active',   -- active | paid | confirmed | released
  reserved_until timestamptz,
  created_at     timestamptz default now()
);
alter table stock_reservations enable row level security;
drop policy if exists sr_read on stock_reservations;
create policy sr_read on stock_reservations for select using (true);   -- readable (availability display); writes via RPC only

-- total stock for a product (is_stock → stock_qty; surplus → surplus_qty + additions) or batch
create or replace function ryuma_stock_total(p_product_id text, p_batch_id text)
returns int language plpgsql security definer set search_path = public, extensions as $$
declare v int;
begin
  if coalesce(p_batch_id,'') <> '' then
    select coalesce(stock_qty,0) into v from product_batches where id = p_batch_id;
    return coalesce(v,0);
  end if;
  select case when is_stock then coalesce(stock_qty,0)
              else coalesce(surplus_qty,0) + coalesce((select sum(qty) from stock_additions where product_id = p.id),0) end
    into v from products p where id = p_product_id;
  return coalesce(v,0);
end $$;

-- units currently held (unexpired active + paid + confirmed)
create or replace function ryuma_held(p_product_id text, p_batch_id text)
returns int language plpgsql security definer set search_path = public, extensions as $$
declare v int;
begin
  if coalesce(p_batch_id,'') <> '' then
    select coalesce(sum(qty),0) into v from stock_reservations
      where batch_id = p_batch_id and (status in ('paid','confirmed') or (status='active' and reserved_until > now()));
  else
    select coalesce(sum(qty),0) into v from stock_reservations
      where product_id = p_product_id and coalesce(batch_id,'')='' and (status in ('paid','confirmed') or (status='active' and reserved_until > now()));
  end if;
  return coalesce(v,0);
end $$;

create or replace function ryuma_available(p_product_id text, p_batch_id text)
returns int language sql security definer set search_path = public, extensions as $$
  select ryuma_stock_total(p_product_id, p_batch_id) - ryuma_held(p_product_id, p_batch_id);
$$;

-- atomic reserve (p_ttl seconds; default 900 = 15 min)
create or replace function ryuma_reserve(p_product_id text, p_batch_id text, p_qty int, p_user_id text, p_ttl int default 900)
returns json language plpgsql security definer set search_path = public, extensions as $$
declare v_avail int; v_id text; v_until timestamptz;
begin
  perform pg_advisory_xact_lock(hashtextextended(coalesce(nullif(p_batch_id,''), p_product_id), 0));
  v_avail := ryuma_available(p_product_id, p_batch_id);
  if v_avail < p_qty then return json_build_object('error','out_of_stock','available',v_avail); end if;
  v_id := gen_random_uuid()::text;
  v_until := now() + make_interval(secs => p_ttl);
  insert into stock_reservations(id, product_id, batch_id, user_id, qty, status, reserved_until)
    values (v_id, p_product_id, nullif(p_batch_id,''), p_user_id, p_qty, 'active', v_until);
  return json_build_object('ok', true, 'reservation_id', v_id, 'until', v_until);
end $$;

create or replace function ryuma_reserve_pay(p_id text)
returns json language plpgsql security definer set search_path = public as $$
begin update stock_reservations set status='paid' where id = p_id and status='active'; return json_build_object('ok', true); end $$;

create or replace function ryuma_reserve_confirm(p_id text)
returns json language plpgsql security definer set search_path = public as $$
begin update stock_reservations set status='confirmed' where id = p_id; return json_build_object('ok', true); end $$;

create or replace function ryuma_reserve_release(p_id text)
returns json language plpgsql security definer set search_path = public as $$
begin update stock_reservations set status='released' where id = p_id; return json_build_object('ok', true); end $$;

grant execute on function ryuma_stock_total(text,text)              to anon, authenticated;
grant execute on function ryuma_held(text,text)                     to anon, authenticated;
grant execute on function ryuma_available(text,text)                to anon, authenticated;
grant execute on function ryuma_reserve(text,text,int,text,int)     to anon, authenticated;
grant execute on function ryuma_reserve_pay(text)                   to anon, authenticated;
grant execute on function ryuma_reserve_confirm(text)               to anon, authenticated;
grant execute on function ryuma_reserve_release(text)               to anon, authenticated;
