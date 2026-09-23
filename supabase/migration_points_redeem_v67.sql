-- ⛔ ไม่ต้องรันไฟล์นี้แล้ว (2026-09-23): รวมอยู่ใน migration_points_all_v70.sql ครบแล้ว — รัน v70 ไฟล์เดียว
-- (ตรวจ production พบว่า v67 ไม่เคยลง และ v69 อ้างคอลัมน์ของ v67 → รัน v69 เดี่ยวๆ จะทำให้การจ่ายส่วนต่าง/สั่งซื้อของลูกค้าล้ม)
-- ============================================================================
-- Ryuma — v67: ใช้แต้ม (จองแต้มฝั่ง DB) + ปิดช่องแก้คูปอง/แต้มบนแถวเงิน (ryuma-points-redeem-spec สเต็ป 1)
-- วางใน SQL Editor แล้วกด Run ได้เลย · รันซ้ำได้ · ไม่ทำข้อมูลเสีย · Depends on v63/v64/v65/v66
--
-- กติกา (เจ้าของ 2026-09-12): ใช้แต้มได้ตอน "ปิดใบพรี" สูงสุด 200/ใบ และ "ซื้อพร้อมส่ง" สูงสุด 400/ออเดอร์
--   ขั้นต่ำ 50 · 1 แต้ม = 1฿ · ไม่ใช้กับมัดจำพรี · ลำดับหัก: ส่วนลดแรงค์ → คูปอง → แต้ม
--
-- หลักการกันบั๊ก (บทเรียน orphan coupon v38/v39): ลูกค้าเขียน point_ledger ไม่ได้ (RLS) → "การจองแต้ม"
--   ต้องเกิดใน trigger ตอน INSERT แถวเงิน (security definer) ในทรานแซกชันเดียวกัน ล็อกต่อคน
--   แต้มไม่พอ = raise = แถวสลิปไม่เกิดเลย ไม่มี "จองแล้วแต่สลิปไม่ลง" · ปฏิเสธ = trigger คืนเอง
--   แถวที่ trigger สร้างมี id คงที่ (pl-redeem-<row id> / pl-refund-<row id>) → แอปโชว์ล่วงหน้าได้
--   แต่ adapter ห้ามส่งแถว id พวกนี้ขึ้นเอง (DB-owned)
--
-- ⚠ บั๊กเดิมที่ปิดในไฟล์นี้ (ตรวจพบ 2026-09-12): guard v63 ล็อก status/amount/user_id แต่ **ไม่ล็อก
--   coupon_discount / coupon_grant_id** ทั้งบน remaining_payments และ orders ทั้งที่ RLS ให้ลูกค้า UPDATE แถวตัวเอง
--   → ลูกค้าแก้ coupon_discount ของสลิปที่รอตรวจเป็นเลขใหญ่ได้ → ตอนแอดมินอนุมัติ หนี้ถูกหักด้วยเลขนั้น
--   (approveRemainingPayment: remaining = remaining_amount − coupon_discount) = หนี้หายฟรี
--   ตอนนี้: INSERT ตรวจคูปองกับ coupon_grants/coupons จริง (เจ้าของ+เพดาน value) · UPDATE ล็อกทุกคอลัมน์เงิน
-- ============================================================================

-- ── 1) คอลัมน์ ───────────────────────────────────────────────────────────────
alter table remaining_payments add column if not exists points_redeemed int default 0;
alter table remaining_payments add column if not exists group_id text;          -- สลิปเดียวจ่ายหลายใบ (สเต็ป 3)
create index if not exists remaining_payments_group_idx on remaining_payments(group_id);
alter table orders add column if not exists points_redeemed int default 0;

-- เพดานใหม่ (ต่อรายการ ไม่คูณ qty): ปิดใบพรี 200 · ออเดอร์พร้อมส่ง 400 — แก้เฉพาะแถวที่ยังเป็นค่าตั้งต้น v66
alter table shop_settings alter column points_max_per_piece_pre set default 200;
alter table shop_settings alter column points_max_per_piece_instock set default 400;
update shop_settings set points_max_per_piece_pre = 200 where coalesce(points_max_per_piece_pre, 100) = 100;
update shop_settings set points_max_per_piece_instock = 400 where coalesce(points_max_per_piece_instock, 200) = 200;

-- ── 2) guard remaining_payments (แทน v63): ตรวจคูปองตอน INSERT + ล็อกคอลัมน์เงินตอน UPDATE ──
create or replace function ryuma_guard_remaining()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_uid text := app_user_id(); v_val numeric; v_scope text; v_active boolean;
begin
  if is_app_admin() then return new; end if;
  if TG_OP = 'INSERT' then
    -- upsert แถวเดิม (เซฟล้มแล้วส่งซ้ำ) → ให้ด่าน UPDATE คุม
    if exists (select 1 from remaining_payments r where r.id = new.id) then return new; end if;
    new.user_id     := v_uid;
    new.status      := 'pending';       -- ลูกค้าอนุมัติสลิปให้ตัวเองไม่ได้
    new.approved_at := null;
    -- ตั๋วต้องเป็นของตัวเอง
    if not exists (select 1 from preorder_tickets t where t.id = new.ticket_id and t.owner_id = v_uid) then
      raise exception 'ryuma: จ่ายส่วนต่างได้เฉพาะตั๋วของตัวเอง';
    end if;
    -- คูปอง: ต้องเป็น grant ของตัวเอง + เพดานไม่เกิน value ของคูปอง + scope พรี (แอปเปลี่ยน grant เป็น used ก่อนแถวนี้เสมอ)
    if new.coupon_grant_id is null then
      new.coupon_discount := 0;
    else
      select c.value, c.scope, c.active into v_val, v_scope, v_active
        from coupon_grants g join coupons c on c.id = g.coupon_id
       where g.id = new.coupon_grant_id and g.user_id = v_uid;
      if v_val is null or coalesce(v_active, false) = false or v_scope not in ('preorder', 'both') then
        raise exception 'ryuma: คูปองใช้ไม่ได้';
      end if;
      new.coupon_discount := least(greatest(coalesce(new.coupon_discount, 0), 0), v_val);
    end if;
    new.points_redeemed := greatest(coalesce(new.points_redeemed, 0), 0);
    return new;
  end if;
  new.status          := old.status;        -- ห้ามเปลี่ยน pending → approved เอง
  new.amount          := old.amount;
  new.approved_at     := old.approved_at;
  new.ticket_id       := old.ticket_id;
  new.user_id         := old.user_id;
  new.coupon_grant_id := old.coupon_grant_id;   -- ← ปิดช่อง (เดิมแก้ได้)
  new.coupon_discount := old.coupon_discount;   -- ← ปิดช่อง (เดิมแก้ได้)
  new.points_redeemed := old.points_redeemed;   -- แต้มที่จองไว้แก้ทีหลังไม่ได้
  new.group_id        := old.group_id;
  return new;
end $$;

drop trigger if exists ryuma_remaining_guard on remaining_payments;
create trigger ryuma_remaining_guard before insert or update on remaining_payments
  for each row execute function ryuma_guard_remaining();

-- ── 3) guard orders (แทน v63): ล็อกคูปอง/แต้มตอน UPDATE ──────────────────────
create or replace function ryuma_guard_orders()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if is_app_admin() then return new; end if;
  if TG_OP = 'INSERT' then
    if exists (select 1 from orders o where o.id = new.id) then return new; end if;
    new.user_id := app_user_id();
    new.status  := 'pending_approval';  -- ลูกค้าอนุมัติออเดอร์ตัวเองไม่ได้
    new.points_redeemed := greatest(coalesce(new.points_redeemed, 0), 0);
    -- คูปอง in-stock: grant ต้องเป็นของตัวเอง (ยอดจริงแอดมินเทียบสลิปกับ total_deposit อยู่แล้ว)
    if new.coupon_grant_id is not null and not exists (
      select 1 from coupon_grants g where g.id = new.coupon_grant_id and g.user_id = app_user_id()
    ) then raise exception 'ryuma: คูปองใช้ไม่ได้'; end if;
    return new;
  end if;
  new.status          := old.status;
  new.total_deposit   := old.total_deposit;
  new.user_id         := old.user_id;
  new.approved_at     := old.approved_at;
  new.coupon_grant_id := old.coupon_grant_id;   -- ← ปิดช่อง (เดิมแก้ได้)
  new.coupon_discount := old.coupon_discount;   -- ← ปิดช่อง (เดิมแก้ได้)
  new.points_redeemed := old.points_redeemed;
  return new;
end $$;

drop trigger if exists ryuma_orders_guard on orders;
create trigger ryuma_orders_guard before insert or update on orders
  for each row execute function ryuma_guard_orders();

-- ── 4) จองแต้ม: BEFORE INSERT remaining_payments ──────────────────────────────
-- ⚠ ชื่อ trigger ขึ้นต้น "ryuma_zz_" ให้ทำงาน "หลัง" guard (Postgres ยิง trigger ชื่อเรียงตัวอักษร)
--    แต่ไม่พึ่งลำดับ: user_id ใช้ app_user_id() เองเมื่อไม่ใช่แอดมิน
create or replace function ryuma_points_hold_rp()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_uid text; v_bal int; v_min int; v_cap int; v_on boolean; v_due numeric; v_owner text;
begin
  if coalesce(new.points_redeemed, 0) <= 0 then return new; end if;
  if exists (select 1 from remaining_payments r where r.id = new.id) then return new; end if; -- upsert ซ้ำ ไม่จองซ้ำ
  v_uid := case when is_app_admin() then new.user_id else app_user_id() end;
  select points_enabled, points_min_redeem, points_max_per_piece_pre into v_on, v_min, v_cap from shop_settings where id = 'default';
  if not coalesce(v_on, false) then raise exception 'ryuma: ระบบแต้มยังไม่เปิดใช้'; end if;
  select owner_id, (remaining_amount - coalesce(remaining_paid, 0)) into v_owner, v_due from preorder_tickets where id = new.ticket_id;
  if v_owner is null then raise exception 'ryuma: ไม่พบตั๋ว'; end if;
  if v_owner <> v_uid then raise exception 'ryuma: ใช้แต้มได้เฉพาะตั๋วของตัวเอง'; end if;
  if new.points_redeemed > coalesce(v_cap, 200) then raise exception 'ryuma: ใช้แต้มได้สูงสุด % ต่อใบ', coalesce(v_cap, 200); end if;
  if new.points_redeemed < coalesce(v_min, 50) then raise exception 'ryuma: ใช้แต้มขั้นต่ำ %', coalesce(v_min, 50); end if;
  if new.points_redeemed > v_due - coalesce(new.coupon_discount, 0) then raise exception 'ryuma: แต้มเกินยอดค้างของใบนี้'; end if;
  perform pg_advisory_xact_lock(hashtextextended('ryuma_points:' || v_uid, 0));
  select coalesce(sum(delta), 0) into v_bal from point_ledger where user_id = v_uid;
  if new.points_redeemed > v_bal then raise exception 'ryuma: แต้มไม่พอ (คงเหลือ % แต้ม — อาจมีสลิปอื่นจองแต้มอยู่)', v_bal; end if;
  insert into point_ledger(id, user_id, delta, kind, ref_type, ref_id, note, created_by)
    values ('pl-redeem-' || new.id, v_uid, -new.points_redeemed, 'redeem_remaining', 'remaining_payment', new.id,
            'ใช้แต้มลดส่วนต่าง ' || new.points_redeemed || ' แต้ม (รอตรวจสลิป)', 'system')
    on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists ryuma_zz_points_hold_rp on remaining_payments;
create trigger ryuma_zz_points_hold_rp before insert on remaining_payments
  for each row execute function ryuma_points_hold_rp();

-- ── 5) จองแต้ม: BEFORE INSERT orders (พร้อมส่ง) ────────────────────────────────
-- ⚠ ตอน INSERT orders ยังไม่มี order_items (adapter เขียน orders ก่อน) → DB เช็คได้แค่ เปิด/ขั้นต่ำ/เพดาน 400/ยอดคงเหลือ
--    "ใช้กับบรรทัดพร้อมส่งเท่านั้น" เช็คซ้ำตอนแอดมินอนุมัติ (approveOrder) ส่วนเกินคืนอัตโนมัติ
create or replace function ryuma_points_hold_order()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_uid text; v_bal int; v_min int; v_cap int; v_on boolean;
begin
  if coalesce(new.points_redeemed, 0) <= 0 then return new; end if;
  if exists (select 1 from orders o where o.id = new.id) then return new; end if;
  v_uid := case when is_app_admin() then new.user_id else app_user_id() end;
  select points_enabled, points_min_redeem, points_max_per_piece_instock into v_on, v_min, v_cap from shop_settings where id = 'default';
  if not coalesce(v_on, false) then raise exception 'ryuma: ระบบแต้มยังไม่เปิดใช้'; end if;
  if new.points_redeemed > coalesce(v_cap, 400) then raise exception 'ryuma: ใช้แต้มได้สูงสุด % ต่อออเดอร์', coalesce(v_cap, 400); end if;
  if new.points_redeemed < coalesce(v_min, 50) then raise exception 'ryuma: ใช้แต้มขั้นต่ำ %', coalesce(v_min, 50); end if;
  perform pg_advisory_xact_lock(hashtextextended('ryuma_points:' || v_uid, 0));
  select coalesce(sum(delta), 0) into v_bal from point_ledger where user_id = v_uid;
  if new.points_redeemed > v_bal then raise exception 'ryuma: แต้มไม่พอ (คงเหลือ % แต้ม — อาจมีสลิปอื่นจองแต้มอยู่)', v_bal; end if;
  insert into point_ledger(id, user_id, delta, kind, ref_type, ref_id, note, created_by)
    values ('pl-redeem-' || new.id, v_uid, -new.points_redeemed, 'redeem_order', 'order', new.id,
            'ใช้แต้มลดของพร้อมส่ง ' || new.points_redeemed || ' แต้ม (รอตรวจสลิป)', 'system')
    on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists ryuma_zz_points_hold_order on orders;
create trigger ryuma_zz_points_hold_order before insert on orders
  for each row execute function ryuma_points_hold_order();

-- ── 6) คืนแต้ม ───────────────────────────────────────────────────────────────
-- remaining_payments: ปฏิเสธสลิป = แอดมิน "ลบแถว" (rejectRemainingPayment) → AFTER DELETE คืนเฉพาะที่ยังไม่ได้อนุมัติ
create or replace function ryuma_points_refund_rp()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if coalesce(old.points_redeemed, 0) > 0 and old.status = 'pending'
     and exists (select 1 from point_ledger e where e.id = 'pl-redeem-' || old.id) then
    insert into point_ledger(id, user_id, delta, kind, ref_type, ref_id, note, created_by)
      values ('pl-refund-' || old.id, old.user_id, old.points_redeemed, 'refund', 'remaining_payment', old.id,
              'คืนแต้ม ' || old.points_redeemed || ' — สลิปส่วนต่างไม่ผ่าน', 'system')
      on conflict (id) do nothing;
  end if;
  return old;
end $$;

drop trigger if exists ryuma_zz_points_refund_rp on remaining_payments;
create trigger ryuma_zz_points_refund_rp after delete on remaining_payments
  for each row execute function ryuma_points_refund_rp();

-- orders: ปฏิเสธ = status → 'rejected' (แถวคงอยู่) → AFTER UPDATE คืน
create or replace function ryuma_points_refund_order()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'rejected' and old.status is distinct from 'rejected' and coalesce(old.points_redeemed, 0) > 0
     and exists (select 1 from point_ledger e where e.id = 'pl-redeem-' || old.id) then
    insert into point_ledger(id, user_id, delta, kind, ref_type, ref_id, note, created_by)
      values ('pl-refund-' || old.id, old.user_id, old.points_redeemed, 'refund', 'order', old.id,
              'คืนแต้ม ' || old.points_redeemed || ' — สลิปไม่ผ่าน', 'system')
      on conflict (id) do nothing;
  end if;
  return new;
end $$;

drop trigger if exists ryuma_zz_points_refund_order on orders;
create trigger ryuma_zz_points_refund_order after update on orders
  for each row execute function ryuma_points_refund_order();

-- ── ตรวจหลังรัน (ไม่บังคับ) ──────────────────────────────────────────────────
-- select tgname, tgrelid::regclass from pg_trigger where tgname like 'ryuma_%points%' and not tgisinternal;
-- select points_max_per_piece_pre, points_max_per_piece_instock from shop_settings;
