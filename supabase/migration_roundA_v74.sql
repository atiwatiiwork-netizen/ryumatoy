-- ============================================================================
-- Ryuma — v74: แก้บั๊กรอบ A (audit เปลี่ยนใบพรี 2026-10-03)
-- วางใน SQL Editor แล้วกด Run ได้เลย · รันซ้ำได้ · ไม่ทำข้อมูลเสีย · ⚠ ต้องรัน v71 v72 v73 ก่อน (รันแล้วทั้งหมด)
--
-- ราก 1: "แอดมินเซฟจากหน้าที่โหลดไว้นาน" (stale whole-row upsert) ทับผลไฟนอลได้ เพราะ guard ตั๋วปล่อยแอดมินผ่านหมด
--   → ตั๋วที่เคยผ่านตลาด: เจ้าของ/เลขตั๋ว/จำนวนชิ้น/สินค้า เปลี่ยนผ่านการเขียนตารางไม่ได้อีกแล้ว (แม้แอดมิน) — ทางเดียวคือ RPC ไฟนอล
--   → คอลัมน์ market_rev = เลขรุ่นของตั๋ว เพิ่มทุกครั้งที่ไฟนอล · แอปส่งเลขรุ่นที่ตัวเองโหลดมาด้วยทุกครั้งที่แก้ตั๋ว
--     ถ้าเลขไม่ตรง (หน้าจอเก่ากว่าไฟนอล) แล้วจะแก้เงิน/สถานะ/วิธีรับของ → ปฏิเสธ "รีเฟรชก่อน"
--   → ระหว่างดีลค้าง (ลงขาย/ข้อเสนอ/รอไฟนอล) แอดมินก็แก้เงิน/สถานะ/วิธีรับของไม่ได้ และจ่ายส่วนต่างแทรกไม่ได้
--   → ตั๋วที่เปลี่ยนมือแล้ว แก้มัดจำไม่ได้ (เงินจะไม่ลงบัญชีใคร) · ลบไม่ได้ · ยกเลิกรายการในออเดอร์ที่ตั๋วเกิดมาไม่ได้
--   → สลิปส่วนต่างทุกแถว (รวมของแอดมิน) ต้องเป็นของคนถือตั๋วตอนนี้ และยอดต้องไม่เกินยอดค้าง
--   → ไฟนอลเทียบยอดเงินกับ snapshot ตอนตกลงกัน ถ้าไม่ตรง = ปฏิเสธ 'ticket_changed'
-- ราก 2: ลบสมาชิก (ryuma_admin_purge_user) ไม่รู้จักตลาด → ปฏิเสธถ้ามีดีลค้าง หรือมีตั๋วที่ได้มา/ขายไปผ่านตลาด
-- เสริม: guard_user_columns กัน suspended · ลูกค้าแก้วิธีรับของหลังแอดมินรับเรื่องแล้วไม่ได้
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 1) คอลัมน์เลขรุ่นของตั๋ว + ตัวช่วย
-- ─────────────────────────────────────────────────────────────────────────────
alter table preorder_tickets add column if not exists market_rev int not null default 0;

-- ตั๋วนี้เคยผ่านตลาดไหม (ลงขาย/เปลี่ยนใบ/ถูกแตก/เป็นตั๋วลูก) — ใช้ล็อกโครงสร้างของตั๋ว
create or replace function ryuma_ticket_market_history(p_id text, p_split_from text)
returns boolean language sql stable security definer set search_path = public as $$
  select p_split_from is not null
      or exists (select 1 from ticket_transfers tr where tr.ticket_id = p_id or tr.child_ticket_id = p_id)
      or exists (select 1 from preorder_tickets c where c.split_from = p_id);
$$;

-- ตั๋วนี้ "เปลี่ยนมือจริงแล้ว" ไหม (ไฟนอลแล้ว/ถูกแตก/เป็นตั๋วลูก) — ใช้ล็อกการแก้มัดจำ
create or replace function ryuma_ticket_transferred(p_id text, p_split_from text)
returns boolean language sql stable security definer set search_path = public as $$
  select p_split_from is not null
      or exists (select 1 from ticket_transfers tr
                  where tr.status in ('done', 'approved') and (tr.ticket_id = p_id or tr.child_ticket_id = p_id))
      or exists (select 1 from preorder_tickets c where c.split_from = p_id);
$$;

revoke all on function ryuma_ticket_market_history(text, text) from public, anon, authenticated;
revoke all on function ryuma_ticket_transferred(text, text)    from public, anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2) guard ตั๋ว (ทับ v71) — เพิ่มด่านฝั่งแอดมิน · ฝั่งลูกค้าเหมือน v71 ทุกบรรทัด + market_rev + ล็อกวิธีรับของหลังรับเรื่อง
--    ข้ามด่านได้ทางเดียว: ryuma.market_rpc = 'on' (ตั้งเฉพาะใน ryuma_market_finalize แบบ local ต่อทรานแซกชัน)
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function ryuma_guard_tickets()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_oi order_items%rowtype; v_p products%rowtype; v_unit_price numeric; v_unit_dep numeric;
begin
  if current_setting('ryuma.market_rpc', true) = 'on' then return new; end if;

  if is_app_admin() then
    if TG_OP = 'INSERT' then return new; end if;
    -- (a) โครงสร้างของตั๋วที่เคยผ่านตลาด: เปลี่ยนผ่านการเขียนตารางไม่ได้ (ทางเดียวคือไฟนอล) — เก็บค่าเดิมเงียบๆ
    --     กันหน้าจอเก่าเขียนเจ้าของ/เลขตั๋ว/จำนวนชิ้นกลับเป็นของคนขาย (audit R2A-01)
    if ryuma_ticket_market_history(old.id, old.split_from) then
      new.id                := old.id;
      new.owner_id          := old.owner_id;
      new.original_buyer_id := old.original_buyer_id;
      new.ticket_no         := old.ticket_no;
      new.split_from        := old.split_from;
      new.qty               := old.qty;
      new.product_id        := old.product_id;
      new.variant_id        := old.variant_id;
      new.batch_id          := old.batch_id;
    end if;
    -- (b) เลขรุ่นไม่ตรง = หน้าจอโหลดก่อนไฟนอล → ห้ามแก้เงิน/สถานะ/วิธีรับของ (audit R2A-01 แตกขาย, R2A-02)
    if new.market_rev is distinct from old.market_rev then
      if row(new.deposit_paid, new.remaining_amount, new.remaining_paid, new.status, new.delivery)
         is distinct from row(old.deposit_paid, old.remaining_amount, old.remaining_paid, old.status, old.delivery) then
        raise exception 'ryuma: ตั๋ว % เปลี่ยนมือหรือแตกขายไปแล้ว — รีเฟรชหน้าก่อนแก้', old.ticket_no;
      end if;
      new.market_rev := old.market_rev;
    end if;
    -- (c) ดีลค้างอยู่ → แอดมินก็แก้เงิน/สถานะ/วิธีรับของไม่ได้ (ผู้ซื้อตกลงตามยอดใน snapshot แล้ว · audit R2B-01)
    if ryuma_market_active(old.id)
       and row(new.deposit_paid, new.remaining_amount, new.remaining_paid, new.status, new.delivery)
           is distinct from row(old.deposit_paid, old.remaining_amount, old.remaining_paid, old.status, old.delivery) then
      raise exception 'ryuma: ตั๋ว % อยู่ระหว่างซื้อขาย/เปลี่ยนใบ — ยกเลิกดีลก่อนแก้เงินหรือสถานะ', old.ticket_no;
    end if;
    -- (d) ตั๋วที่เปลี่ยนมือแล้ว: แก้มัดจำไม่ได้ (เงินจะไม่ลงบัญชีใครเลย · audit R3-16)
    if new.deposit_paid is distinct from old.deposit_paid and ryuma_ticket_transferred(old.id, old.split_from) then
      raise exception 'ryuma: ตั๋ว % เปลี่ยนมือแล้ว แก้มัดจำไม่ได้', old.ticket_no;
    end if;
    -- (e) ตั๋วที่เปลี่ยนมือแล้ว: ยอดเต็มขึ้นไม่ได้ (หน้าจอแอปรุ่นเก่าที่ไม่ส่งเลขรุ่น เขียนยอดก่อนแตกขายกลับให้ใบแม่ · review รอบ A)
    --     ยอดลดลงได้ (คูปอง/แต้ม) · จ่ายเพิ่มได้ (อนุมัติสลิป)
    if new.remaining_amount > old.remaining_amount and ryuma_ticket_transferred(old.id, old.split_from) then
      raise exception 'ryuma: ตั๋ว % เปลี่ยนมือแล้ว เพิ่มยอดค้างไม่ได้ — รีเฟรชหน้าก่อนแก้', old.ticket_no;
    end if;
    return new;
  end if;

  if TG_OP = 'INSERT' then
    if exists (select 1 from preorder_tickets t where t.id = new.id) then return new; end if;
    -- ลูกค้าออกตั๋วเองได้ทางเดียว = self-heal ตั๋วที่หายของรายการในออเดอร์ตัวเองที่อนุมัติแล้ว (id t-<item>)
    -- ค่าเงิน/สถานะ/คนจ่าย คำนวณที่นี่ทั้งหมด ไม่เชื่อค่าจากเครื่องลูกค้า (review รอบ A: เดิมลูกค้าตั้งยอดค้าง 0 + 'ถึงไทย' เองได้
    -- และออกตั๋วซ้ำให้รายการที่ขายไปแล้วได้ ถ้าตั๋วเดิมเป็น id รุ่นเก่า)
    select oi.* into v_oi from order_items oi join orders o on o.id = oi.order_id
     where 't-' || oi.id = new.id and o.user_id = app_user_id() and o.status = 'approved' and oi.product_id = new.product_id;
    if not found then
      raise exception 'ryuma: ออกตั๋วเองไม่ได้ (ต้องมาจากออเดอร์ที่อนุมัติแล้วเท่านั้น)';
    end if;
    if coalesce(v_oi.qty, 0) <= 0 then raise exception 'ryuma: รายการนี้ถูกยกเลิกแล้ว ออกตั๋วไม่ได้'; end if;
    if exists (select 1 from ticket_transfers tr where tr.order_item_id = v_oi.id) then
      raise exception 'ryuma: ตั๋วของรายการนี้เคยซื้อขาย/เปลี่ยนใบแล้ว ออกตั๋วใหม่ไม่ได้';
    end if;
    -- ตั๋วรุ่นเก่า (id ไม่ผูกรายการ): ถ้าจำนวนตั๋วของคนจ่าย (ไม่นับตั๋วลูก) ครบจำนวนรายการแล้ว = ไม่ได้หาย
    if (select count(*) from preorder_tickets x
         where coalesce(x.original_buyer_id, x.owner_id) = app_user_id() and x.split_from is null
           and x.product_id = v_oi.product_id and x.variant_id is not distinct from v_oi.variant_id
           and x.batch_id is not distinct from v_oi.batch_id)
       >= (select count(*) from order_items i join orders o on o.id = i.order_id
            where o.user_id = app_user_id() and o.status = 'approved' and coalesce(i.qty, 0) > 0
              and i.product_id = v_oi.product_id and i.variant_id is not distinct from v_oi.variant_id
              and i.batch_id is not distinct from v_oi.batch_id) then
      raise exception 'ryuma: ตั๋วของรายการนี้มีอยู่แล้ว';
    end if;
    select * into v_p from products where id = v_oi.product_id;
    v_unit_price := coalesce(v_oi.unit_price, (select v.price_total from product_variants v where v.id = v_oi.variant_id), v_p.price_total, 0);
    v_unit_dep   := coalesce(v_oi.unit_deposit, (select v.deposit_amount from product_variants v where v.id = v_oi.variant_id), v_p.deposit_amount, 0);
    new.owner_id := app_user_id();
    new.original_buyer_id := app_user_id();
    new.variant_id := v_oi.variant_id;
    new.batch_id := v_oi.batch_id;
    new.qty := coalesce(v_oi.qty, 1);
    new.deposit_paid := least(coalesce(new.deposit_paid, 0), coalesce(v_oi.deposit_amount, 0));
    new.remaining_amount := greatest(0, v_unit_price - v_unit_dep) * coalesce(v_oi.qty, 1);
    new.remaining_paid := 0;
    new.status := case when greatest(0, v_unit_price - v_unit_dep) <= 0 then 'paid_full' else 'active' end;
    -- สูตรเดียวกับ mirrorStatusFor (mutations.ts): รอบมัดจำบน SKU ที่จบไปแล้ว = เริ่ม 'open'
    new.product_status := case when v_oi.batch_id is not null and greatest(0, v_unit_price - v_unit_dep) > 0
                                    and v_p.status in ('arrived', 'delivered', 'closed') then 'open' else v_p.status end;
    new.split_from := null;
    new.market_rev := 0;
    new.delivery := null;
    return new;
  end if;

  -- คนที่ไม่ใช่ผู้ถือตอนนี้ (เช่นคนขายเดิมที่ยังเป็น original_buyer ตาม RLS v21) แก้ตั๋วไม่ได้ทุกช่อง
  -- (review รอบ A: เดิมคนขายเปลี่ยนวิธีรับของ/ที่อยู่ของตั๋วที่ขายไปแล้วได้)
  if old.owner_id is distinct from app_user_id() then return old; end if;
  new.id               := old.id;
  new.created_at       := old.created_at;
  new.deposit_paid     := old.deposit_paid;
  new.remaining_amount := old.remaining_amount;
  new.remaining_paid   := old.remaining_paid;
  new.status           := old.status;
  new.product_status   := old.product_status;
  new.ticket_no        := old.ticket_no;
  new.owner_id         := old.owner_id;
  new.original_buyer_id := old.original_buyer_id;
  new.product_id       := old.product_id;
  new.variant_id       := old.variant_id;
  new.batch_id         := old.batch_id;
  new.qty              := old.qty;
  new.parcel_no        := old.parcel_no;
  new.carrier          := old.carrier;
  new.approved_at      := old.approved_at;
  new.qr_code_url      := old.qr_code_url;
  new.warehouse_at        := old.warehouse_at;
  new.warehouse_transport := old.warehouse_transport;
  new.warehouse_slip      := old.warehouse_slip;
  new.parcel_image     := old.parcel_image;
  new.shipped_out_at   := old.shipped_out_at;
  new.split_from       := old.split_from;
  new.market_rev       := old.market_rev;
  if ryuma_market_active(old.id) then new.delivery := old.delivery; end if;
  -- แอดมินรับเรื่องแล้ว (accepted_at) → ลูกค้าแก้วิธีรับของไม่ได้ (กันเครื่องลูกค้าเซฟซ้ำแล้วลบการรับเรื่อง · audit R3-06)
  if old.delivery is not null and coalesce(old.delivery ->> 'accepted_at', '') <> '' then new.delivery := old.delivery; end if;
  return new;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3) ห้ามลบตั๋วที่เคยผ่านตลาด แม้แอดมิน (หลักฐานว่าใครขายให้ใคร + เงินที่แบ่งให้ตั๋วลูก)
--    ลูกค้า: trigger เดิม ryuma_tickets_nodelete ยกเลิกการลบเงียบๆ อยู่แล้ว
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function ryuma_tickets_market_nodelete()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if current_setting('ryuma.market_rpc', true) = 'on' then return old; end if;
  if is_app_admin() and ryuma_ticket_market_history(old.id, old.split_from) then
    raise exception 'ryuma: ตั๋ว % มีประวัติซื้อขาย/เปลี่ยนใบ ลบไม่ได้ (ต้องเก็บเป็นหลักฐาน)', old.ticket_no;
  end if;
  return old;
end $$;
drop trigger if exists ryuma_tickets_market_nodelete on preorder_tickets;
create trigger ryuma_tickets_market_nodelete before delete on preorder_tickets
  for each row execute function ryuma_tickets_market_nodelete();

-- รายการในออเดอร์ที่ตั๋วเกิดมา: ลด qty (ยกเลิก) ไม่ได้ถ้าตั๋วของมันเคยผ่านตลาด
-- (เดิม deleteTicket ยกเลิกรายการสำเร็จก่อน แล้วลบตั๋วไม่ผ่าน = ครึ่งทาง · audit R2A-02)
create or replace function ryuma_order_items_market_lock()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_t preorder_tickets%rowtype;
begin
  if current_setting('ryuma.market_rpc', true) = 'on' then return new; end if;
  if coalesce(new.qty, 0) < coalesce(old.qty, 0) then
    select * into v_t from preorder_tickets where id = 't-' || old.id;
    if found and ryuma_ticket_market_history(v_t.id, v_t.split_from) then
      raise exception 'ryuma: ตั๋ว % มีประวัติซื้อขาย/เปลี่ยนใบ ยกเลิกรายการนี้ไม่ได้', v_t.ticket_no;
    end if;
    -- ตั๋วรุ่นเก่า (id ไม่ผูกรายการ) — ดีลบันทึกรายการต้นทางไว้ที่ ticket_transfers.order_item_id
    if exists (select 1 from ticket_transfers tr where tr.order_item_id = old.id) then
      raise exception 'ryuma: รายการนี้เป็นต้นทางของตั๋วที่มีประวัติซื้อขาย/เปลี่ยนใบ ยกเลิกไม่ได้';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists ryuma_order_items_market_lock on order_items;
create trigger ryuma_order_items_market_lock before update on order_items
  for each row execute function ryuma_order_items_market_lock();

-- ─────────────────────────────────────────────────────────────────────────────
-- 4) สลิปส่วนต่าง: ทุกแถวใหม่ (รวมของแอดมิน) ต้องเป็นของคนถือตั๋วตอนนี้ + ยอดไม่เกินยอดค้าง
--    · กัน "จบงานนอกระบบ" จากหน้าจอเก่าบันทึกเงินเป็นของคนขายหลังโอนไปแล้ว (audit R2A-02)
--    · กันเครื่องเก่าจ่ายยอดก่อนแตกขาย แล้วส่วนเกินหายเงียบ (audit R3-12)
--    ลำดับ trigger (ชื่อเรียงตามอักษร): ryuma_market_rp_lock → ryuma_remaining_guard (ลูกค้า: ตั้ง user_id) → ryuma_rp_owner_check → ryuma_zz_points_hold_rp
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function ryuma_rp_owner_check()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_t preorder_tickets%rowtype;
begin
  if current_setting('ryuma.market_rpc', true) = 'on' or current_setting('ryuma.trusted', true) = 'on' then return new; end if;
  if exists (select 1 from remaining_payments r where r.id = new.id) then return new; end if; -- upsert แถวเดิม
  select * into v_t from preorder_tickets where id = new.ticket_id;
  if not found then raise exception 'ryuma: ไม่พบตั๋วของสลิปนี้'; end if;
  if new.user_id is distinct from v_t.owner_id then
    raise exception 'ryuma: ตั๋ว % เปลี่ยนเจ้าของไปแล้ว — รีเฟรชหน้าก่อน', v_t.ticket_no;
  end if;
  if coalesce(new.amount, 0) > greatest(0, coalesce(v_t.remaining_amount, 0) - coalesce(v_t.remaining_paid, 0)) then
    raise exception 'ryuma: ยอดสลิปเกินยอดค้างของตั๋ว % — รีเฟรชหน้าเช็คยอดล่าสุด', v_t.ticket_no;
  end if;
  return new;
end $$;
drop trigger if exists ryuma_rp_owner_check on remaining_payments;
create trigger ryuma_rp_owner_check before insert on remaining_payments
  for each row execute function ryuma_rp_owner_check();

-- ล็อกจ่ายส่วนต่างระหว่างดีลค้าง (ทับ v71): เลิกยกเว้นแอดมิน (เดิมแอดมิน "จบงานนอกระบบ" แทรกกลางดีลได้ · audit R2B-01)
create or replace function ryuma_market_rp_lock()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from remaining_payments r where r.id = new.id) then return new; end if; -- upsert แถวเดิม
  if ryuma_market_active(new.ticket_id) then
    raise exception 'ryuma: ใบนี้อยู่ระหว่างซื้อขาย/เปลี่ยนใบ — จบดีลหรือถอนก่อนจ่ายส่วนต่าง';
  end if;
  return new;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5) ไฟนอล (ทับ v71) — + เทียบยอดกับ snapshot · + ยกด่าน guard แบบ local · + เพิ่มเลขรุ่นตั๋ว
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function ryuma_market_finalize(p_id text, p_order_item_id text default null)
returns json language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid text := app_user_id(); tr ticket_transfers%rowtype; t preorder_tickets%rowtype; s record;
  v_qty int; v_base text; v_n int; v_no text; v_child text; v_payer text; v_name text;
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

-- ─────────────────────────────────────────────────────────────────────────────
-- 6) ลบสมาชิก (ทับ v26) — รู้จักตลาด: ปฏิเสธถ้ามีดีลค้าง หรือมีตั๋วที่ได้มา/ขายไปผ่านตลาด
--    เดิม: ลบผู้รับ → แถวโอนสิทธิ์หาย คนขายเสกตั๋วคืน · ลบคนขาย → ออเดอร์/สลิปที่ค้ำตั๋วผู้รับหาย ·
--    ลบระหว่างดีล → สลิป/บัญชี/หลักฐานหายหมด (audit R3-01, R3-02, R2B-02) · ทางเลือกแทน = "ระงับ" (suspend)
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function ryuma_admin_purge_user(p_user_id text)
returns json language plpgsql security definer set search_path = public, extensions as $$
declare v_auth uuid; v_live int; v_hist int; v_recv int; v_sold int;
begin
  if not is_app_admin() then return json_build_object('error','not_admin'); end if;
  select count(*) into v_live from ticket_transfers tr
   where (tr.from_user_id = p_user_id or tr.to_user_id = p_user_id)
     and ryuma_market_live(tr.status, tr.hold_until, tr.expires_at);
  if v_live > 0 then return json_build_object('error', 'live_deal', 'live', v_live); end if;
  select count(*) into v_hist from ticket_transfers tr
   where (tr.from_user_id = p_user_id or tr.to_user_id = p_user_id)
     and (tr.status in ('done', 'approved') or tr.paid_at is not null);
  select count(*) into v_recv from preorder_tickets t
   where t.owner_id = p_user_id and (coalesce(t.original_buyer_id, t.owner_id) <> p_user_id or t.split_from is not null);
  select count(*) into v_sold from preorder_tickets t
   where t.original_buyer_id = p_user_id and t.owner_id <> p_user_id;
  if v_hist + v_recv + v_sold > 0 then
    return json_build_object('error', 'market_history', 'deals', v_hist, 'received', v_recv, 'sold', v_sold);
  end if;

  select auth_id into v_auth from users where id = p_user_id;
  -- ประกาศ/ข้อเสนอที่จบแล้วโดยไม่มีเงินเปลี่ยนมือ (ถอน/หมดอายุ/ปฏิเสธ) ลบได้ ไม่ใช่หลักฐานเงิน
  delete from ticket_transfers where from_user_id = p_user_id or to_user_id = p_user_id
     or ticket_id in (select id from preorder_tickets where owner_id = p_user_id);
  delete from remaining_payments where user_id = p_user_id
     or ticket_id in (select id from preorder_tickets where owner_id = p_user_id);
  delete from preorder_tickets where owner_id = p_user_id;
  delete from order_items where order_id in (select id from orders where user_id = p_user_id);
  delete from orders where user_id = p_user_id;
  delete from rank_requests where user_id = p_user_id;
  delete from stock_reservations where user_id = p_user_id;
  delete from user_secrets where user_id = p_user_id;
  delete from users where id = p_user_id;
  if v_auth is not null then delete from auth.users where id = v_auth; end if;
  return json_build_object('ok', true);
end $$;
revoke all on function ryuma_admin_purge_user(text) from public, anon;
grant execute on function ryuma_admin_purge_user(text) to authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 7) guard users (ทับ v65) — + suspended (เดิมเครื่องลูกค้าที่เซฟซ้ำปลดระงับตัวเองได้ · audit R3-06 / 0928)
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function guard_user_columns()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if is_app_admin() or current_setting('ryuma.trusted', true) = 'on' then return new; end if;

  if TG_OP = 'INSERT' then
    if exists (select 1 from users u where u.id = new.id) then return new; end if;
    new.is_admin    := false;
    new.approved    := false;
    new.rank        := 'bronze';
    new.total_spent := 0;
    new.suspended   := false;
    return new;
  end if;

  if new.id is distinct from old.id
     or new.auth_id     is distinct from old.auth_id
     or new.is_admin    is distinct from old.is_admin
     or new.approved    is distinct from old.approved
     or new.rank        is distinct from old.rank
     or new.total_spent is distinct from old.total_spent
     or new.member_code is distinct from old.member_code
     or new.phone       is distinct from old.phone
     or new.fb_link     is distinct from old.fb_link
     or new.pin_reset   is distinct from old.pin_reset
     or new.suspended   is distinct from old.suspended
  then raise exception 'ryuma: not allowed to modify protected user columns'; end if;
  return new;
end $$;

-- ── ตรวจหลังรัน (ไม่บังคับ) ──────────────────────────────────────────────────
-- select market_rev from preorder_tickets limit 1;                                     -- คอลัมน์ใหม่ (ค่า 0)
-- select tgname from pg_trigger where tgname in ('ryuma_tickets_market_nodelete','ryuma_order_items_market_lock','ryuma_rp_owner_check'); -- 3 แถว
