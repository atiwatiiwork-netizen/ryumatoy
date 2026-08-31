-- ============================================================================
-- Ryuma — v64: ปิดช่องที่ v63 ไม่ครอบ (re-audit 2026-08-31) · วางใน SQL Editor แล้วกด Run
-- รันซ้ำได้ ไม่ทำข้อมูลเสีย · ไม่ต้องแก้โค้ดฝั่งแอปเลย (แอปทำงานเหมือนเดิม)
-- ⚠ รัน migration_lockdown_v63.sql (ฉบับแก้แล้ว) ก่อน แล้วค่อยรันไฟล์นี้
--
-- ปิด 4 เรื่อง โดยเรียงความอันตราย:
--   C1  ยกตัวเองเป็นแอดมินเต็มระบบ — สมาชิกที่ล็อกอินแล้ว insert แถว users ที่ is_admin=true
--       ให้ตัวเองได้ เพราะ trigger กันคอลัมน์เดิมเป็น "before update" เท่านั้น ไม่คุม INSERT
--       (อันตรายกว่าทุกช่องที่ v63 แก้ เพราะแอดมิน = บายพาส RLS/การ์ดทุกตัว)
--   H2  ลบแถวเงิน/ตั๋ว/รายการ/ออเดอร์ของตัวเองได้ — RLS เป็น for-all และ v63 คุมแค่ insert/update
--       ต่อยอด: ลบตั๋วแล้ว insert คืนให้ยอดค้าง=0 → รับของโดยไม่จ่ายส่วนต่าง
--   OI  ตาราง order_items ไม่มีการ์ดเลย — ปลด void (qty 0→N) แล้ว self-heal มินต์ตั๋วที่แอดมินลบคืนได้
--   H3  ryuma_reserve เชื่อ user_id จาก client + เปิดให้ anon เรียก → จองกันสต๊อก (DoS) + สวมชื่อคนจอง
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- C1) users — กัน insert แถวที่ตั้งสิทธิ์พิเศษให้ตัวเอง (ยกระดับเป็นแอดมิน)
--     รวม guard เดิม (UPDATE) เข้ากับ INSERT: คนที่ไม่ใช่แอดมิน/ไม่ผ่าน RPC ที่เชื่อถือได้
--     ถ้า insert แถว users จะถูกบังคับ is_admin=false / approved=false / rank=bronze / total_spent=0
--     (การสมัคร/ผูกบัญชีจริงวิ่งผ่าน RPC ที่ตั้ง ryuma.trusted='on' อยู่แล้ว → ไม่กระทบ)
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function guard_user_columns()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if is_app_admin() or current_setting('ryuma.trusted', true) = 'on' then return new; end if;

  if TG_OP = 'INSERT' then
    -- ⚠ แอปเซฟด้วย upsert → INSERT trigger ยิงแม้แถวมีอยู่: ลูกค้าแก้ที่อยู่/โปรไฟล์ = upsert
    --   แถวเดิม ต้องปล่อยผ่านให้ด่าน UPDATE คุม ไม่งั้นบังคับ approved=false แล้วชนด่าน
    --   update จนเซฟล้ม (เหตุการณ์จริง 2026-08-31 — แก้ใน v65 และที่นี่)
    if exists (select 1 from users u where u.id = new.id) then return new; end if;
    new.is_admin    := false;      -- ⛔ กันยกตัวเองเป็นแอดมิน (ช่องวิกฤตเดิม)
    new.approved    := false;      -- ต้องให้แอดมินอนุมัติเท่านั้น
    new.rank        := 'bronze';   -- ห้ามเกิดมาแรงก์สูง (ราคา/สิทธิ์เข้าถึงพิเศษ)
    new.total_spent := 0;          -- ห้ามปั๊มยอดใช้จ่ายเพื่ออัปแรงก์
    return new;
  end if;

  -- UPDATE (ตรรกะเดิมจาก v23) — ห้ามแก้คอลัมน์อ่อนไหว
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
  then raise exception 'ryuma: not allowed to modify protected user columns'; end if;
  return new;
end $$;

drop trigger if exists trg_guard_user on users;
create trigger trg_guard_user before insert or update on users
  for each row execute function guard_user_columns();

-- ─────────────────────────────────────────────────────────────────────────────
-- OI) order_items — เพิ่มการ์ด (เดิมไม่มีเลย)
--     insert ได้เฉพาะลงออเดอร์ของตัวเอง · หลังส่งแล้วห้ามแก้รายการ (ลด qty เพื่อยกเลิกได้
--     แต่ปลด void qty 0→N หรือสลับสินค้า/รุ่น/มัดจำไม่ได้ → กัน self-heal มินต์ตั๋วที่แอดมินลบคืน)
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function ryuma_guard_order_items()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_owner text;
begin
  if is_app_admin() or current_setting('ryuma.trusted', true) = 'on' then return new; end if;

  if TG_OP = 'INSERT' then
    -- upsert แถวเดิม → ปล่อยผ่านให้ด่าน UPDATE คุม (เหตุผลเดียวกับ guard users/tickets)
    if exists (select 1 from order_items i where i.id = new.id) then return new; end if;
    select o.user_id into v_owner from orders o where o.id = new.order_id;
    if v_owner is distinct from app_user_id() then
      raise exception 'ryuma: เพิ่มรายการในออเดอร์คนอื่นไม่ได้';
    end if;
    return new;
  end if;

  new.product_id     := old.product_id;
  new.variant_id     := old.variant_id;
  new.order_id       := old.order_id;
  new.deposit_amount := old.deposit_amount;
  new.batch_id       := old.batch_id;
  new.qty            := least(coalesce(new.qty, old.qty), old.qty);  -- ลด(ยกเลิก)ได้ · เพิ่ม/ปลด void ไม่ได้
  return new;
end $$;

drop trigger if exists ryuma_order_items_guard on order_items;
create trigger ryuma_order_items_guard before insert or update on order_items
  for each row execute function ryuma_guard_order_items();

-- ─────────────────────────────────────────────────────────────────────────────
-- H2) ห้ามคนธรรมดา DELETE แถวเงิน/ตั๋ว/รายการ/ออเดอร์ (v63 คุมแค่ insert/update)
--     ใช้ "ยกเลิกการลบเงียบๆ" (return null) เพื่อไม่ให้ optimistic sync พังกลางคัน —
--     ถ้าเครื่องลูกค้าเผลอสั่งลบ แถวจะถูกดึงกลับมาเองรอบ poll ถัดไป
--     แอดมิน + RPC ที่เชื่อถือได้ (ryuma.trusted) ลบได้ตามปกติ
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function ryuma_block_customer_delete()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if is_app_admin() or current_setting('ryuma.trusted', true) = 'on' then return old; end if;
  return null;   -- ยกเลิกการลบสำหรับคนธรรมดา
end $$;

drop trigger if exists ryuma_tickets_nodelete on preorder_tickets;
create trigger ryuma_tickets_nodelete before delete on preorder_tickets
  for each row execute function ryuma_block_customer_delete();

drop trigger if exists ryuma_orders_nodelete on orders;
create trigger ryuma_orders_nodelete before delete on orders
  for each row execute function ryuma_block_customer_delete();

drop trigger if exists ryuma_order_items_nodelete on order_items;
create trigger ryuma_order_items_nodelete before delete on order_items
  for each row execute function ryuma_block_customer_delete();

drop trigger if exists ryuma_remaining_nodelete on remaining_payments;
create trigger ryuma_remaining_nodelete before delete on remaining_payments
  for each row execute function ryuma_block_customer_delete();

-- ─────────────────────────────────────────────────────────────────────────────
-- H3) ryuma_reserve — บังคับใช้ app_user_id() (ไม่เชื่อ user_id ที่ client ส่งมา) + ตัด anon
--     พารามิเตอร์ p_user_id คงไว้ให้ฝั่งแอปเรียกได้เหมือนเดิม แต่ "ถูกละเลย" ใช้ตัวตนจาก session แทน
--     + เพดาน qty/ttl ต่อครั้ง กันเรียกวนจองกันสต๊อกของ hot
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function ryuma_reserve(p_product_id text, p_batch_id text, p_qty int, p_user_id text, p_ttl int default 900)
returns json language plpgsql security definer set search_path = public, extensions as $$
declare v_avail int; v_id text; v_until timestamptz; v_uid text := app_user_id();
begin
  if v_uid is null then return json_build_object('error','no_session'); end if;
  if p_qty is null or p_qty < 1 or p_qty > 20 then return json_build_object('error','bad_qty'); end if;
  perform pg_advisory_xact_lock(hashtextextended(coalesce(nullif(p_batch_id,''), p_product_id), 0));
  v_avail := ryuma_available(p_product_id, p_batch_id);
  if v_avail < p_qty then return json_build_object('error','out_of_stock','available',v_avail); end if;
  v_id := gen_random_uuid()::text;
  v_until := now() + make_interval(secs => least(coalesce(p_ttl, 900), 1800));
  insert into stock_reservations(id, product_id, batch_id, user_id, qty, status, reserved_until)
    values (v_id, p_product_id, nullif(p_batch_id,''), v_uid, p_qty, 'active', v_until);  -- ← v_uid ไม่ใช่ p_user_id
  return json_build_object('ok', true, 'reservation_id', v_id, 'until', v_until);
end $$;

revoke execute on function ryuma_reserve(text,text,int,text,int) from anon;

-- ── ตรวจหลังรัน (ไม่บังคับ) ──────────────────────────────────────────────────
-- 1) ต้องมี trigger ครบ:
-- select tgname, tgrelid::regclass from pg_trigger
--   where tgname in ('trg_guard_user','ryuma_order_items_guard','ryuma_tickets_nodelete',
--                    'ryuma_orders_nodelete','ryuma_order_items_nodelete','ryuma_remaining_nodelete')
--   and not tgisinternal order by tgrelid::text;
-- 2) ⚠ ตรวจว่าไม่มีใครแอบยกตัวเองเป็นแอดมินไปก่อนหน้านี้ — ต้องเหลือเฉพาะบัญชีเจ้าของจริง:
-- select id, display_name, phone, is_admin from users where is_admin = true;
