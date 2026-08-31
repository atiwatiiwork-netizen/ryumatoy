-- ============================================================================
-- Ryuma — v65: แก้ด่วน guard v63/v64 ให้รองรับ upsert (2026-08-31 คืนเดียวกับที่รัน v63/v64)
-- วางใน SQL Editor แล้วกด Run ได้เลย · รันซ้ำได้ · ไม่ทำข้อมูลเสีย
--
-- ปัญหา: แอปเซฟข้อมูลด้วย upsert (INSERT ... ON CONFLICT UPDATE) ซึ่ง Postgres ยิง
-- BEFORE INSERT trigger เสมอแม้แถวจะมีอยู่แล้ว → guard ของ v63/v64 ที่เขียนไว้สำหรับ
-- "แถวใหม่จริงๆ" เลยไปขวางการแก้แถวเดิมของลูกค้า:
--   1) ลูกค้าที่ถือตั๋วมอบ/ตั๋ว legacy (id ไม่ใช่ t-<oi.id>) กดเลือกวิธีรับของ
--      → guard ตั๋วคิดว่าออกตั๋วเอง → raise → เซฟล้มตลอดกาล
--   2) ลูกค้าแก้ที่อยู่/โปรไฟล์ → guard users บังคับ approved=false ตอน insert
--      → ชนด่าน update ("ห้ามแก้ approved") → raise → เซฟล้ม
-- ทางแก้: ใน INSERT branch ถ้าแถว id นี้มีอยู่แล้ว = เส้น upsert-update → ปล่อยผ่าน
-- ให้ด่าน BEFORE UPDATE (ที่บังคับทุกคอลัมน์อ่อนไหวกลับค่าเดิมอยู่แล้ว) คุมแทน
-- ============================================================================

-- ── 1) guard ตั๋ว (จาก v63) ──────────────────────────────────────────────────
create or replace function ryuma_guard_tickets()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if is_app_admin() then return new; end if;

  if TG_OP = 'INSERT' then
    -- upsert แถวเดิม (ตั๋วมีอยู่แล้ว) → ให้ด่าน UPDATE ข้างล่างคุม ไม่ใช่การออกตั๋วใหม่
    if exists (select 1 from preorder_tickets t where t.id = new.id) then return new; end if;
    -- ตั๋วที่ลูกค้า "ออกเองได้" มีทางเดียว: ตัวกู้ตั๋วที่หายจากออเดอร์ที่อนุมัติแล้ว
    if not exists (
      select 1 from order_items oi join orders o on o.id = oi.order_id
      where 't-' || oi.id = new.id
        and o.user_id = app_user_id()
        and o.status = 'approved'
        and oi.product_id = new.product_id
    ) then
      raise exception 'ryuma: ออกตั๋วเองไม่ได้ (ต้องมาจากออเดอร์ที่อนุมัติแล้วเท่านั้น)';
    end if;
    new.owner_id := app_user_id();
    new.remaining_paid := 0;
    new.status := 'active';
    new.variant_id := (select oi.variant_id from order_items oi where 't-' || oi.id = new.id);
    new.qty := coalesce((select oi.qty from order_items oi where 't-' || oi.id = new.id), 1);
    new.deposit_paid := least(coalesce(new.deposit_paid, 0),
      coalesce((select oi.deposit_amount from order_items oi where 't-' || oi.id = new.id), 0));
    return new;
  end if;

  -- UPDATE: ลูกค้าแตะได้อย่างเดียวคือ "วิธีรับของ" (delivery) — คอลัมน์อื่นบังคับกลับค่าเดิม
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
  return new;
end $$;

-- ── 2) guard users (จาก v64) ─────────────────────────────────────────────────
create or replace function guard_user_columns()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if is_app_admin() or current_setting('ryuma.trusted', true) = 'on' then return new; end if;

  if TG_OP = 'INSERT' then
    -- upsert แถวเดิม (โปรไฟล์ตัวเองมีอยู่แล้ว) → ให้ด่าน UPDATE คุม
    if exists (select 1 from users u where u.id = new.id) then return new; end if;
    -- แถวใหม่จริง: ห้ามเกิดมาพร้อมสิทธิ์พิเศษ (ปิดช่องยกตัวเองเป็นแอดมิน)
    new.is_admin    := false;
    new.approved    := false;
    new.rank        := 'bronze';
    new.total_spent := 0;
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
  then raise exception 'ryuma: not allowed to modify protected user columns'; end if;
  return new;
end $$;

-- ── 3) guard order_items (จาก v64) — เส้น upsert แถวเดิมให้ผ่านไปด่าน UPDATE เช่นกัน ──
create or replace function ryuma_guard_order_items()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_owner text;
begin
  if is_app_admin() or current_setting('ryuma.trusted', true) = 'on' then return new; end if;

  if TG_OP = 'INSERT' then
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
  new.qty            := least(coalesce(new.qty, old.qty), old.qty);
  return new;
end $$;

-- (guard remaining_payments / orders / auction_entries ของ v63 ไม่ raise ใน INSERT
--  และด่าน UPDATE บังคับค่ากลับอยู่แล้ว → เส้น upsert ปลอดภัยโดยไม่ต้องแก้)

-- ── ตรวจหลังรัน (ไม่บังคับ) ──────────────────────────────────────────────────
-- select proname from pg_proc where proname in
--   ('ryuma_guard_tickets','guard_user_columns','ryuma_guard_order_items');
