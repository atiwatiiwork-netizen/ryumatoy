-- ============================================================================
-- Ryuma — admin "delete member completely" (run this). Safe to re-run.
-- The X on the members page previously deleted only the users row, leaving the
-- Supabase Auth login (so they could log back in — and v25 would re-provision them)
-- plus orphaned orders/tickets. This RPC removes EVERYTHING for a member so they
-- must sign up again: their orders/tickets/payments/rank-requests/transfers/reservations,
-- their PIN secret, the users row, AND their Supabase Auth account (the login).
-- Admin-only. Irreversible — the UI asks for confirmation.
-- ============================================================================

create or replace function ryuma_admin_purge_user(p_user_id text)
returns json language plpgsql security definer set search_path = public, extensions as $$
declare v_auth uuid;
begin
  if not is_app_admin() then return json_build_object('error','not_admin'); end if;
  select auth_id into v_auth from users where id = p_user_id;

  -- tickets they originally bought but transferred away → detach so the users delete is legal
  update preorder_tickets set original_buyer_id = null
    where original_buyer_id = p_user_id and owner_id <> p_user_id;

  -- marketplace listings involving this user, and any on their owned tickets
  delete from ticket_transfers where from_user_id = p_user_id or to_user_id = p_user_id
     or ticket_id in (select id from preorder_tickets where owner_id = p_user_id);

  -- their remaining-payment records + tickets they currently own (tickets cascade to
  -- remaining_payments via ticket_id, but delete explicitly to be safe)
  delete from remaining_payments where user_id = p_user_id
     or ticket_id in (select id from preorder_tickets where owner_id = p_user_id);
  delete from preorder_tickets where owner_id = p_user_id;

  -- their orders (order_items cascade via order_id, deleted explicitly too)
  delete from order_items where order_id in (select id from orders where user_id = p_user_id);
  delete from orders where user_id = p_user_id;

  delete from rank_requests where user_id = p_user_id;
  delete from stock_reservations where user_id = p_user_id;
  delete from user_secrets where user_id = p_user_id;
  delete from users where id = p_user_id;

  -- finally remove the login so the phone is free to sign up fresh
  if v_auth is not null then delete from auth.users where id = v_auth; end if;

  return json_build_object('ok', true);
end $$;

grant execute on function ryuma_admin_purge_user(text) to anon, authenticated;
