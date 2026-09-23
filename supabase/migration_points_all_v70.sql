-- ============================================================================
-- Ryuma — v70: ระบบคะแนน "ครบชุดในไฟล์เดียว" (รวม v67 + v69 + กติกาใหม่ 2026-09-23)
-- วางใน SQL Editor แล้วกด Run ไฟล์นี้ไฟล์เดียว · รันซ้ำได้ · ไม่ทำข้อมูลเสีย · ใช้แทน v67 และ v69 (ไม่ต้องรันสองไฟล์นั้น)
--
-- ⚠ ตรวจ production 2026-09-23: v67 ไม่เคยลงจริง (ไม่มีคอลัมน์ remaining_payments.points_redeemed / group_id,
--   orders.points_redeemed · เพดานยังเป็น 100/200) — น่าจะ error กลางไฟล์แล้วทั้งไฟล์ถูกยกเลิก
--   ผลคือช่องโหว่ที่ v67 ตั้งใจปิด (ลูกค้าแก้ส่วนลดคูปองของสลิปที่รอตรวจได้) ยังเปิดอยู่ → ไฟล์นี้ปิดให้
--   และถ้าเคยรัน v69 ไปแล้ว (v69 อ้างคอลัมน์ที่ยังไม่มี = การจ่ายส่วนต่าง/สั่งซื้อของลูกค้าล้ม) → ไฟล์นี้เพิ่มคอลัมน์ก่อน = หาย
--
-- กติกา (เจ้าของ 2026-09-23): ใช้แต้มตอนปิดใบพรีรอบปกติ สูงสุด 200/ใบ · ปิดใบพรีรอบพิเศษ / ของพร้อมส่ง สูงสุด 400/ใบ
--   ขั้นต่ำ 50 · 1 แต้ม = 1฿ · ไม่ใช้กับมัดจำ · สวิตช์ "ใช้แต้มตัดยอด" (app_config points_redeem) ต้องเปิดก่อนถึงจะใช้ได้
-- Depends on v39 / v63 / v64 / v66 (app_user_id(), is_app_admin(), point_ledger)
-- ============================================================================

-- ── 1) คอลัมน์ (จาก v67) ─────────────────────────────────────────────────────
alter table remaining_payments add column if not exists points_redeemed int default 0;
alter table remaining_payments add column if not exists group_id text;          -- สลิปเดียวจ่ายหลายใบ
create index if not exists remaining_payments_group_idx on remaining_payments(group_id);
alter table orders add column if not exists points_redeemed int default 0;

-- ── 2) เพดานการใช้แต้ม (ต่อใบ) ─────────────────────────────────────────────────
alter table shop_settings alter column points_max_per_piece_pre set default 200;
alter table shop_settings alter column points_max_per_piece_instock set default 400;
update shop_settings set points_max_per_piece_pre = 200, points_max_per_piece_instock = 400 where id = 'default';

-- ── 3) guard remaining_payments: ตั๋วต้องเป็นของตัวเอง · คูปองต้องเป็น grant ที่ "ใช้กับใบนี้" จริง · UPDATE ล็อกคอลัมน์เงิน ──
create or replace function ryuma_guard_remaining()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_uid text := app_user_id(); v_val numeric; v_scope text; v_active boolean; v_status text; v_ticket text;
begin
  if is_app_admin() then return new; end if;
  if TG_OP = 'INSERT' then
    if exists (select 1 from remaining_payments r where r.id = new.id) then return new; end if; -- upsert แถวเดิม → ด่าน UPDATE คุม
    new.user_id     := v_uid;
    new.status      := 'pending';
    new.approved_at := null;
    if not exists (select 1 from preorder_tickets t where t.id = new.ticket_id and t.owner_id = v_uid) then
      raise exception 'ryuma: จ่ายส่วนต่างได้เฉพาะตั๋วของตัวเอง';
    end if;
    if new.coupon_grant_id is null then
      new.coupon_discount := 0;
    else
      select c.value, c.scope, c.active, g.status, g.ticket_id into v_val, v_scope, v_active, v_status, v_ticket
        from coupon_grants g join coupons c on c.id = g.coupon_id
       where g.id = new.coupon_grant_id and g.user_id = v_uid;
      if v_val is null or coalesce(v_active, false) = false or v_scope not in ('preorder', 'both')
         or v_status is distinct from 'used' or v_ticket is distinct from new.ticket_id
         or exists (select 1 from remaining_payments r where r.coupon_grant_id = new.coupon_grant_id and r.id <> new.id) then
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
  new.coupon_grant_id := old.coupon_grant_id;
  new.coupon_discount := old.coupon_discount;
  new.points_redeemed := old.points_redeemed;
  new.group_id        := old.group_id;
  return new;
end $$;

drop trigger if exists ryuma_remaining_guard on remaining_payments;
create trigger ryuma_remaining_guard before insert or update on remaining_payments
  for each row execute function ryuma_guard_remaining();

-- ── 4) guard orders: คูปองต้องเป็น grant ที่ "ใช้กับออเดอร์นี้" + scope พร้อมส่ง · UPDATE ล็อกคอลัมน์เงิน ──
create or replace function ryuma_guard_orders()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_val numeric; v_scope text; v_active boolean; v_status text; v_order text;
begin
  if is_app_admin() then return new; end if;
  if TG_OP = 'INSERT' then
    if exists (select 1 from orders o where o.id = new.id) then return new; end if;
    new.user_id := app_user_id();
    new.status  := 'pending_approval';
    new.points_redeemed := greatest(coalesce(new.points_redeemed, 0), 0);
    if new.coupon_grant_id is null then
      new.coupon_discount := 0;
    else
      select c.value, c.scope, c.active, g.status, g.order_id into v_val, v_scope, v_active, v_status, v_order
        from coupon_grants g join coupons c on c.id = g.coupon_id
       where g.id = new.coupon_grant_id and g.user_id = app_user_id();
      if v_val is null or coalesce(v_active, false) = false or v_scope not in ('instock', 'both')
         or v_status is distinct from 'used' or v_order is distinct from new.id
         or exists (select 1 from orders o where o.coupon_grant_id = new.coupon_grant_id and o.id <> new.id and o.status <> 'rejected') then
        raise exception 'ryuma: คูปองใช้ไม่ได้';
      end if;
      new.coupon_discount := least(greatest(coalesce(new.coupon_discount, 0), 0), v_val);
    end if;
    return new;
  end if;
  new.status          := old.status;
  new.total_deposit   := old.total_deposit;
  new.user_id         := old.user_id;
  new.approved_at     := old.approved_at;
  new.coupon_grant_id := old.coupon_grant_id;
  new.coupon_discount := old.coupon_discount;
  new.points_redeemed := old.points_redeemed;
  return new;
end $$;

drop trigger if exists ryuma_orders_guard on orders;
create trigger ryuma_orders_guard before insert or update on orders
  for each row execute function ryuma_guard_orders();

-- ── 5) coupon_grants: ลูกค้าสร้างแถวใหม่ไม่ได้ · แก้ได้แค่ active → used ของแถวตัวเอง ──────────
create or replace function ryuma_guard_coupon_grant() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  if is_app_admin() then return new; end if;
  if TG_OP = 'INSERT' then
    if exists (select 1 from coupon_grants g where g.id = new.id) then return new; end if; -- upsert แถวที่แอดมินมอบไว้
    raise exception 'ryuma: คูปองมอบได้เฉพาะแอดมิน';
  end if;
  if old.status = 'active' and new.status = 'used' then
    new.coupon_id  := old.coupon_id;
    new.user_id    := old.user_id;
    new.granted_at := old.granted_at;
    return new;
  end if;
  return old; -- อย่างอื่น = ไม่เปลี่ยนอะไร (ไม่ raise กันเซฟล้มทั้งก้อน)
end $$;

drop trigger if exists coupon_grants_guard on coupon_grants;
create trigger coupon_grants_guard before insert or update on coupon_grants
  for each row execute function ryuma_guard_coupon_grant();

-- ── 6) จองแต้มตอนส่งสลิปส่วนต่าง (ต้องเปิดสวิตช์ใช้แต้ม · รอบพิเศษ 400/ใบ · ปกติ 200/ใบ) ──────────
create or replace function ryuma_points_hold_rp()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_uid text; v_bal int; v_min int; v_cap_pre int; v_cap_big int; v_cap int; v_on boolean; v_due numeric;
        v_owner text; v_batch text; v_redeem boolean;
begin
  if coalesce(new.points_redeemed, 0) <= 0 then return new; end if;
  if exists (select 1 from remaining_payments r where r.id = new.id) then return new; end if; -- upsert ซ้ำ ไม่จองซ้ำ
  if exists (select 1 from point_ledger e where e.id = 'pl-redeem-' || new.id) then
    raise exception 'ryuma: สลิปนี้เคยจองแต้มไปแล้ว — กรุณาส่งสลิปใหม่';
  end if;
  v_uid := case when is_app_admin() then new.user_id else app_user_id() end;
  select points_enabled, points_min_redeem, points_max_per_piece_pre, points_max_per_piece_instock
    into v_on, v_min, v_cap_pre, v_cap_big from shop_settings where id = 'default';
  if not coalesce(v_on, false) then raise exception 'ryuma: ระบบแต้มยังไม่เปิดใช้'; end if;
  select (value -> 'enabled') = 'true'::jsonb into v_redeem from app_config where key = 'points_redeem';
  if not coalesce(v_redeem, false) then raise exception 'ryuma: ยังไม่เปิดให้ใช้แต้มตัดยอด'; end if;
  select owner_id, (remaining_amount - coalesce(remaining_paid, 0)), batch_id into v_owner, v_due, v_batch
    from preorder_tickets where id = new.ticket_id;
  if v_owner is null then raise exception 'ryuma: ไม่พบตั๋ว'; end if;
  if v_owner <> v_uid then raise exception 'ryuma: ใช้แต้มได้เฉพาะตั๋วของตัวเอง'; end if;
  -- รอบพิเศษ (มี batch และไม่ใช่รอบ "หาของ") = เพดานใหญ่ · รอบปกติ = เพดานใบพรี
  v_cap := case
    when v_batch is not null and not exists (select 1 from product_batches b where b.id = v_batch and b.label = 'หาของ')
      then coalesce(v_cap_big, 400)
    else coalesce(v_cap_pre, 200)
  end;
  if new.points_redeemed > v_cap then raise exception 'ryuma: ใช้แต้มได้สูงสุด % ต่อใบ', v_cap; end if;
  if new.points_redeemed < coalesce(v_min, 50) then raise exception 'ryuma: ใช้แต้มขั้นต่ำ %', coalesce(v_min, 50); end if;
  if new.points_redeemed > v_due - coalesce(new.coupon_discount, 0) then raise exception 'ryuma: แต้มเกินยอดค้างของใบนี้'; end if;
  perform pg_advisory_xact_lock(hashtextextended('ryuma_points:' || v_uid, 0));
  select coalesce(sum(delta), 0) into v_bal from point_ledger where user_id = v_uid;
  if new.points_redeemed > v_bal then raise exception 'ryuma: แต้มไม่พอ (คงเหลือ % แต้ม — อาจมีสลิปอื่นจองแต้มอยู่)', v_bal; end if;
  insert into point_ledger(id, user_id, delta, kind, ref_type, ref_id, note, created_by)
    values ('pl-redeem-' || new.id, v_uid, -new.points_redeemed, 'redeem_remaining', 'remaining_payment', new.id,
            'ใช้แต้มลดส่วนต่าง ' || new.points_redeemed || ' แต้ม (รอตรวจสลิป)', 'system')
    on conflict (id) do nothing; -- ส่งซ้ำพร้อมกัน (retry หลัง timeout) — id เก่าที่ใช้ซ้ำถูกดักด้านบนแล้ว
  return new;
end $$;

drop trigger if exists ryuma_zz_points_hold_rp on remaining_payments;
create trigger ryuma_zz_points_hold_rp before insert on remaining_payments
  for each row execute function ryuma_points_hold_rp();

-- ── 7) จองแต้มตอนสั่งของพร้อมส่ง ───────────────────────────────────────────────
-- ตอน INSERT orders ยังไม่มี order_items (แอปเขียน orders ก่อน) → DB รู้แค่ยอดคงเหลือ/ขั้นต่ำ/เพดานรวมคร่าวๆ
-- เพดานจริง "400 ต่อใบ × จำนวนใบพร้อมส่ง" ตรวจตอนแอดมินอนุมัติ (แอป: เกิน = อนุมัติไม่ได้ ต้องปฏิเสธ → คืนแต้มเอง)
create or replace function ryuma_points_hold_order()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_uid text; v_bal int; v_min int; v_cap int; v_on boolean; v_redeem boolean;
begin
  if coalesce(new.points_redeemed, 0) <= 0 then return new; end if;
  if exists (select 1 from orders o where o.id = new.id) then return new; end if;
  if exists (select 1 from point_ledger e where e.id = 'pl-redeem-' || new.id) then
    raise exception 'ryuma: ออเดอร์นี้เคยจองแต้มไปแล้ว — กรุณาสั่งใหม่';
  end if;
  v_uid := case when is_app_admin() then new.user_id else app_user_id() end;
  select points_enabled, points_min_redeem, points_max_per_piece_instock into v_on, v_min, v_cap from shop_settings where id = 'default';
  if not coalesce(v_on, false) then raise exception 'ryuma: ระบบแต้มยังไม่เปิดใช้'; end if;
  select (value -> 'enabled') = 'true'::jsonb into v_redeem from app_config where key = 'points_redeem';
  if not coalesce(v_redeem, false) then raise exception 'ryuma: ยังไม่เปิดให้ใช้แต้มตัดยอด'; end if;
  if new.points_redeemed > coalesce(v_cap, 400) * 20 then raise exception 'ryuma: ใช้แต้มเกินเพดาน'; end if;
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

-- ── 8) คืนแต้ม (จาก v67) ─────────────────────────────────────────────────────
-- สลิปส่วนต่างถูกปฏิเสธ = แอดมินลบแถว → AFTER DELETE คืนเฉพาะที่ยังไม่อนุมัติ
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

-- ออเดอร์ถูกปฏิเสธ = status → 'rejected' (แถวคงอยู่) → AFTER UPDATE คืน
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

-- ── ตรวจหลังรัน (เลือกรันทีละบรรทัดได้) ───────────────────────────────────────
-- select points_max_per_piece_pre, points_max_per_piece_instock from shop_settings;          -- ต้องได้ 200 / 400
-- select column_name from information_schema.columns where table_name in ('remaining_payments','orders') and column_name in ('points_redeemed','group_id');  -- ต้องได้ 3 แถว
-- select tgname from pg_trigger where tgname like 'ryuma_zz_points%' and not tgisinternal;   -- ต้องได้ 4 แถว
-- ก่อนกดเปิดตัว 🚀: ต้องไม่มีแถว
-- select id from point_ledger where kind = 'earn_ticket' and id <> 'pl-earn-' || ref_id;
