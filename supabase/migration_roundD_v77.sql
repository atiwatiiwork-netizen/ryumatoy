-- ============================================================================
-- Ryuma — v77: แก้บั๊กรอบ D (audit เปลี่ยนใบพรี 2026-10-03) — แต้ม/ยศ + สิทธิ์อ่านตั๋ว
-- วางใน SQL Editor แล้วกด Run ได้เลย · รันซ้ำได้ · ไม่ทำข้อมูลเสีย · ⚠ ต้องรัน v74 v75 v76 ก่อน (รันแล้ว)
--
--  เฟส 2 (เจ้าของ 2026-10-02 "ถ้ามาจาก bonus เดือนให้ยกเลิก"): ไฟนอลดึงโบนัสยศที่ผูกกับใบนี้และใช้ไปแล้วคืนจากคนขาย
--  เฟส 2 / audit 0928: RLS ตั๋ว (v21 tickets_own) ให้ "คนสั่งเดิม" อ่าน/เขียนตั๋วที่ขายไปแล้วได้
--        (เห็นที่อยู่จัดส่ง/วิธีรับของของผู้รับ) → อ่าน/เขียนได้เฉพาะคนถือตอนนี้ + แอดมิน
--        คนขายยังเห็นดีล (ticket_transfers) สลิป/ออเดอร์ของตัวเองครบ แอปนับเงิน/เพดานจากส่วนนั้นแล้ว
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 1) สิทธิ์ตั๋ว: คนถือตอนนี้ + แอดมิน เท่านั้น (ทับ v21)
-- ─────────────────────────────────────────────────────────────────────────────
drop policy if exists tickets_own    on preorder_tickets;
drop policy if exists tickets_read   on preorder_tickets;
drop policy if exists tickets_insert on preorder_tickets;
drop policy if exists tickets_update on preorder_tickets;
drop policy if exists tickets_delete on preorder_tickets;
create policy tickets_read on preorder_tickets for select
  using (owner_id = app_user_id() or is_app_admin());
create policy tickets_insert on preorder_tickets for insert
  with check (owner_id = app_user_id() or is_app_admin());
create policy tickets_update on preorder_tickets for update
  using (owner_id = app_user_id() or is_app_admin())
  with check (owner_id = app_user_id() or is_app_admin());
create policy tickets_delete on preorder_tickets for delete
  using (owner_id = app_user_id() or is_app_admin());

-- ─────────────────────────────────────────────────────────────────────────────
-- 2) ไฟนอล (ทับ v74) — เหมือนเดิมทุกบรรทัด + ดึงโบนัสยศรายเดือนคืน
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function ryuma_market_finalize(p_id text, p_order_item_id text default null)
returns json language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid text := app_user_id(); tr ticket_transfers%rowtype; t preorder_tickets%rowtype; s record;
  v_qty int; v_base text; v_n int; v_no text; v_child text; v_payer text; v_name text;
  b point_ledger%rowtype; v_claw numeric; v_clawed numeric;
begin
  if v_uid is null or not is_app_admin() then return json_build_object('error', 'admin_only'); end if;
  select * into tr from ticket_transfers where id = p_id for update;
  if not found then return json_build_object('error', 'not_found'); end if;
  if tr.status in ('done', 'approved') then
    return json_build_object('ok', true, 'again', true, 'new_ticket_no', tr.new_ticket_no, 'child_ticket_id', tr.child_ticket_id); end if;
  if tr.status not in ('paid', 'reviewing', 'seller_ok', 'pending_admin') or tr.to_user_id is null then
    return json_build_object('error', 'bad_status', 'status', tr.status); end if;
  select * into t from preorder_tickets where id = tr.ticket_id for update;
  if not found then return json_build_object('error', 'ticket_missing'); end if;
  if t.owner_id is distinct from tr.from_user_id then return json_build_object('error', 'owner_changed'); end if;
  if t.status = 'shipped' or t.delivery is not null then return json_build_object('error', 'ticket_moving'); end if;
  v_qty := coalesce(tr.qty, t.qty);
  if v_qty < 1 or v_qty > t.qty then return json_build_object('error', 'bad_qty'); end if;
  select * into s from ryuma_split_share(v_qty, greatest(t.qty, 1), t.deposit_paid, t.remaining_amount, t.remaining_paid);
  -- ยอดเงินของชิ้นที่ขายต้องเท่ากับตอนตกลงกัน (snapshot) — ไม่งั้นผู้ซื้อรับหนี้คนละก้อนกับที่เห็น (audit R2B-01)
  if tr.snap is not null and (tr.snap ? 'paid') and (tr.snap ? 'due') then
    if (s.c_dep + s.c_paid) <> (tr.snap ->> 'paid')::numeric or (s.c_rem - s.c_paid) <> (tr.snap ->> 'due')::numeric then
      return json_build_object('error', 'ticket_changed',
        'snap_paid', tr.snap ->> 'paid', 'snap_due', tr.snap ->> 'due', 'paid', s.c_dep + s.c_paid, 'due', s.c_rem - s.c_paid);
    end if;
  end if;
  v_payer := coalesce(t.original_buyer_id, t.owner_id);
  v_base := regexp_replace(t.ticket_no, '-T[0-9]+$', '');
  select coalesce(max((substring(x.ticket_no from '-T([0-9]+)$'))::int), 0) into v_n
    from preorder_tickets x where x.ticket_no like v_base || '-T%';
  v_no := v_base || '-T' || (v_n + 1);
  perform set_config('ryuma.market_rpc', 'on', true);
  if v_qty = t.qty then
    update preorder_tickets
       set original_buyer_id = v_payer, owner_id = tr.to_user_id, ticket_no = v_no, market_rev = t.market_rev + 1
     where id = t.id;
  else
    v_child := 'tc-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 20);
    insert into preorder_tickets (id, ticket_no, product_id, variant_id, batch_id, owner_id, original_buyer_id, qty,
        deposit_paid, remaining_amount, remaining_paid, status, product_status, qr_code_url,
        warehouse_at, warehouse_transport, split_from, created_at, approved_at, market_rev)
    values (v_child, v_no, t.product_id, t.variant_id, t.batch_id, tr.to_user_id, v_payer, v_qty,
        s.c_dep, s.c_rem, s.c_paid, case when s.c_paid >= s.c_rem then 'paid_full' else 'active' end,
        t.product_status, t.qr_code_url, t.warehouse_at, t.warehouse_transport, t.id, now(), t.approved_at, t.market_rev + 1);
    update preorder_tickets
       set original_buyer_id = v_payer, qty = t.qty - v_qty,
           deposit_paid = s.r_dep, remaining_amount = s.r_rem, remaining_paid = s.r_paid,
           status = case when s.r_paid >= s.r_rem then 'paid_full' else 'active' end,
           market_rev = t.market_rev + 1
     where id = t.id;
  end if;
  perform set_config('ryuma.market_rpc', 'off', true);
  -- โบนัสยศรายเดือนที่ผูกกับใบนี้ แล้วถูกใช้/ให้ไปแล้ว → ดึงคืนจากคนขายตามสัดส่วนชิ้นที่ขาย (เจ้าของ 2026-10-02:
  --   "แต้มสะสม ถ้ามาจาก bonus เดือนให้ยกเลิก" · ส่วนที่ยังไม่ได้ใช้ระบบไม่ให้อยู่แล้วเมื่อใบเปลี่ยนมือ)
  --   แถวโบนัส = kind 'monthly_reward' ref_id = id ตั๋ว · แถวดึงคืน = 'reverse_ticket' ref_id = '<ตั๋ว>|mbonus-claw|<ดีล>' (ไม่ซ้ำต่อดีล)
  for b in select * from point_ledger where kind = 'monthly_reward' and ref_type = 'ticket' and ref_id = t.id and delta > 0 loop
    select coalesce(-sum(delta), 0) into v_clawed from point_ledger
     where kind = 'reverse_ticket' and user_id = b.user_id and ref_id like t.id || '|mbonus-claw|%';
    -- สัดส่วนของ "ที่ยังไม่ถูกดึง" ต่อชิ้นที่เหลือในใบตอนนี้ (ขายทีละชิ้นหลายรอบ ดึงรวมไม่เกินสัดส่วนที่ขายจริง · review รอบ D)
    v_claw := round((b.delta - v_clawed) * v_qty::numeric / greatest(t.qty, 1));
    if v_claw > 0 then
      insert into point_ledger (id, user_id, delta, kind, ref_type, ref_id, note, created_by, created_at)
      values ('pl-mclaw-' || p_id || '-' || b.id, b.user_id, -v_claw, 'reverse_ticket', 'ticket', t.id || '|mbonus-claw|' || p_id,
              'ดึงคืนโบนัสยศ — ' || t.ticket_no || ' เปลี่ยนมือ' || case when v_qty < t.qty then ' (' || v_qty || '/' || t.qty || ' ชิ้น)' else '' end,
              v_uid, now())
      on conflict do nothing;
    end if;
  end loop;
  update ticket_transfers
     set status = 'done', approved_at = now(), finalized_by = v_uid, prev_ticket_no = t.ticket_no,
         new_ticket_no = v_no, child_ticket_id = v_child,
         order_item_id = coalesce(order_item_id, p_order_item_id), updated_at = now()
   where id = p_id;
  select display_name into v_name from users where id = v_uid;
  insert into activity_logs (id, actor_id, actor_name, action, summary, target_id, target_label, amount, created_at)
  values ('al-mk-' || p_id, v_uid, v_name, 'market_finalize',
          'ตลาดใบพรี: โอนสิทธิ์ ' || t.ticket_no || ' → ' || v_no
            || case when v_child is not null then ' (แตกขาย ' || v_qty || ' ชิ้น)' else '' end,
          coalesce(v_child, t.id), v_no, tr.asking_price, now())
  on conflict (id) do nothing;
  return json_build_object('ok', true, 'new_ticket_no', v_no, 'child_ticket_id', v_child);
end $$;


-- ── ตรวจหลังรัน (ไม่บังคับ) ──────────────────────────────────────────────────
-- select policyname, cmd from pg_policies where tablename = 'preorder_tickets';   -- tickets_read/insert/update/delete
