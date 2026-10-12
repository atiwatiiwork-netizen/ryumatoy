-- ============================================================================
-- Ryuma — v85: ลงส่วนของ v74 ที่ production ไม่เคยได้รับ + ตัวตรวจสภาพฐานข้อมูล (audit 2026-10-12)
-- ⚠ รันไฟล์นี้ "ไฟล์เดียว" · ห้ามรัน migration_roundA_v74.sql ซ้ำทั้งไฟล์ (จะย้อน 6 ฟังก์ชันที่ v75–v84 แก้ไปแล้ว)
--
-- ที่มา: ตรวจ 2026-10-12 พบว่า production ไม่มี v74 (คอลัมน์ market_rev / ryuma_ticket_transferred / trigger 3 ตัว ไม่มี)
--   ส่วน v75–v84 ลงครบ (ผลเช็คของเจ้าของ 2026-10-12: v75–v84 = true ทุกแถว) → ไฟล์นี้ใส่ "เฉพาะ" ของ v74 ที่ไม่มีไฟล์ไหนหลังจากนั้นทับ:
--   1) คอลัมน์ preorder_tickets.market_rev + ryuma_ticket_transferred + ปิดสิทธิ์เรียก helper ภายใน
--   2) ryuma_guard_tickets รุ่น v74 (ด่านแท็บแอดมินเก่า · ห้ามแก้เงินระหว่างดีล · self-heal คิดยอดเองฝั่งเซิร์ฟเวอร์ = กันตั๋วซ้ำ)
--   3) ห้ามลบตั๋วที่มีประวัติตลาด + ห้ามยกเลิกรายการออเดอร์ของตั๋วนั้น (trigger · ฟังก์ชันเป็นของ v83)
--   4) สลิปส่วนต่างทุกแถวต้องเป็นของคนถือตั๋ว + ยอดไม่เกินยอดค้าง
--   5) ใหม่: ryuma_schema_check() — ตรวจว่า migration ตลาดลงครบไหม (หน้า /admin/market เรียก · ไม่ครบ = ห้ามเปิดสวิตช์)
--   ทดสอบแล้ว (PGlite): chain ที่ไม่มี v74 + ไฟล์นี้ = เหมือน chain เต็มทุกฟังก์ชัน/trigger/policy/คอลัมน์ · รันซ้ำได้ (ไม่ย้อนอะไร)
--   เทสต์: npm run audit:sql (deploy85-audit)
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 1) คอลัมน์เลขรุ่นของตั๋ว + ตัวช่วย
-- ─────────────────────────────────────────────────────────────────────────────
alter table preorder_tickets add column if not exists market_rev int not null default 0;

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

-- ─────────────────────────────────────────────────────────────────────────────
-- 5) ตัวตรวจสภาพฐานข้อมูลตลาด (อ่านอย่างเดียว) — แอดมิน หรือรันใน SQL Editor (ไม่มี session ลูกค้า) · ลูกค้า = ได้ผลว่าง
--    migration ตลาดตัวถัดไปที่เพิ่มของ ให้ create or replace ฟังก์ชันนี้แล้วต่อแถวของตัวเอง
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function ryuma_schema_check()
returns table (step int, version text, item text, ok boolean)
language sql stable security definer set search_path = public as $fn$
with fp as (
  select p.oid, p.proname, p.pronargs, replace(p.prosrc, chr(13), '') src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'
), trg as (
  select c.relname tbl, t.tgname from pg_trigger t join pg_class c on c.oid = t.tgrelid where not t.tgisinternal
), pol as (
  select policyname, coalesce(qual, '') qual, coalesce(with_check, '') chk from pg_policies where schemaname = 'public' and tablename = 'preorder_tickets'
), col as (
  select table_name::text table_name, column_name::text column_name, is_nullable::text is_nullable from information_schema.columns where table_schema = 'public'
), a(o, v, chk, ok) as (
  select 1, 'v71', 'ticket_transfers.qty column', exists(select 1 from col where table_name = 'ticket_transfers' and column_name = 'qty')
  union all select 2, 'v72', 'fn ryuma_market_open', exists(select 1 from fp where proname = 'ryuma_market_open')
  union all select 3, 'v73', 'fn ryuma_wallet_code', exists(select 1 from fp where proname = 'ryuma_wallet_code')
  union all select 4, 'v74', 'preorder_tickets.market_rev column', exists(select 1 from col where table_name = 'preorder_tickets' and column_name = 'market_rev')
  union all select 5, 'v74', 'fn ryuma_ticket_transferred', exists(select 1 from fp where proname = 'ryuma_ticket_transferred')
  union all select 6, 'v74', 'ryuma_guard_tickets carries the market_rev token', exists(select 1 from fp where proname = 'ryuma_guard_tickets' and src like '%market_rev%')
  union all select 7, 'v74', 'trigger remaining_payments.ryuma_rp_owner_check', exists(select 1 from trg where tbl = 'remaining_payments' and tgname = 'ryuma_rp_owner_check')
  union all select 8, 'v74', 'trigger preorder_tickets.ryuma_tickets_market_nodelete', exists(select 1 from trg where tbl = 'preorder_tickets' and tgname = 'ryuma_tickets_market_nodelete')
  union all select 9, 'v74', 'trigger order_items.ryuma_order_items_market_lock', exists(select 1 from trg where tbl = 'order_items' and tgname = 'ryuma_order_items_market_lock')
  union all select 10, 'v74', 'ryuma_ticket_market_history NOT executable by anon', not exists(select 1 from fp where proname = 'ryuma_ticket_market_history' and has_function_privilege('anon', oid, 'execute'))
  union all select 11, 'v75', 'fn late_slip_resolve + 5-arg offer dropped', exists(select 1 from fp where proname = 'ryuma_market_late_slip_resolve') and not exists(select 1 from fp where proname = 'ryuma_market_offer' and pronargs = 5)
  union all select 12, 'v76', 'payout vault + 4-arg list only + review std_deposit calc', exists(select 1 from pg_class where relname = 'ticket_transfer_payouts')
                         and not exists(select 1 from fp where proname = 'ryuma_market_list' and pronargs <> 4)
                         and exists(select 1 from fp where proname = 'ryuma_item_std_deposit_calc' and src like '%deposit_mega%')
  union all select 13, 'v77', 'ticket RLS = holder + admin only (no tickets_own / original_buyer_id)', not exists(select 1 from pol where policyname = 'tickets_own')
                         and (select count(*) from pol where policyname in ('tickets_read', 'tickets_insert', 'tickets_update', 'tickets_delete')) = 4
                         and not exists(select 1 from pol where qual like '%original_buyer_id%' or chk like '%original_buyer_id%')
  union all select 14, 'v78', 'trigger ticket_transfers.ryuma_transfers_keep_recipient', exists(select 1 from trg where tbl = 'ticket_transfers' and tgname = 'ryuma_transfers_keep_recipient')
  union all select 15, 'v78', 'rp_lock locks the ticket row, no admin bypass', exists(select 1 from fp where proname = 'ryuma_market_rp_lock' and src like '%for update%' and src not like '%is_app_admin()%')
  union all select 16, 'v78', 'purge refuses self/admin (review version)', exists(select 1 from fp where proname = 'ryuma_admin_purge_user' and src like '%admin_target%')
  union all select 17, 'v78', 'feed counts board sales only', exists(select 1 from fp where proname = 'ryuma_market_feed' and src like '%coalesce(d.kind, ''market'') = ''market'') as seller_sold%')
  union all select 18, 'v79', 'cancel_note column + 2-arg cancel only', exists(select 1 from col where table_name = 'ticket_transfers' and column_name = 'cancel_note') and not exists(select 1 from fp where proname = 'ryuma_market_cancel' and pronargs <> 2)
  union all select 19, 'v80', 'guard_user_columns: first phone allowed + suspended locked', exists(select 1 from fp where proname = 'guard_user_columns' and src like '%coalesce(old.phone, '''') <> ''''%' and src like '%new.suspended%is distinct from old.suspended%')
  union all select 20, 'v80', 'sourcing + coupon guards raise ryuma: messages', (select count(*) from fp where proname in ('ryuma_guard_sourcing', 'ryuma_guard_coupon_grant') and src like '%ryuma:%') = 2
  union all select 21, 'v81', 'table product_lines', exists(select 1 from pg_class where relname = 'product_lines')
  union all select 22, 'v82', 'table external_parcels', exists(select 1 from pg_class where relname = 'external_parcels')
  union all select 23, 'v83', 'transfer_counts + is_shop_image + finalize advisory lock + qty not null', exists(select 1 from fp where proname = 'ryuma_transfer_counts') and exists(select 1 from fp where proname = 'ryuma_is_shop_image')
                         and exists(select 1 from fp where proname = 'ryuma_market_finalize' and src like '%pg_advisory_xact_lock(hashtext(''ryuma_ticket_no:''%')
                         and exists(select 1 from col where table_name = 'preorder_tickets' and column_name = 'qty' and is_nullable = 'NO')
  union all select 24, 'v84', 'seller_flag + has_bell + slip_history', exists(select 1 from fp where proname = 'ryuma_market_seller_flag') and exists(select 1 from fp where proname = 'ryuma_has_bell') and exists(select 1 from col where table_name = 'ticket_transfers' and column_name = 'slip_history')
  union all select 25, 'v85', 'fn ryuma_schema_check', true
)
select o, v, chk, ok from a
 where auth.uid() is null or is_app_admin()
 order by o;
$fn$;
revoke all on function ryuma_schema_check() from public, anon;
grant execute on function ryuma_schema_check() to authenticated;

-- ── ตรวจหลังรัน: ต้องได้ ok_count = 25 และ total = 25
--    (ถ้าไม่ครบ ดูแถวที่เป็น false ด้วย:  select * from ryuma_schema_check() where not ok;)
select count(*) filter (where ok) as ok_count, count(*) as total from ryuma_schema_check();
