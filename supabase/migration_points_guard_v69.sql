-- ============================================================================
-- Ryuma — v69: ปิดช่องก่อนเปิดระบบคะแนนให้ลูกค้า (audit 2026-09-23) · วางใน SQL Editor แล้วกด Run · รันซ้ำได้
-- Depends on v39 / v63 / v66 / v67 (แทนที่ฟังก์ชันเดิมชื่อเดิม — trigger ผูกชื่อฟังก์ชันอยู่แล้ว ไม่ต้องสร้างใหม่)
--
-- 1) สวิตช์ "ใช้แต้มตัดยอด" ต้องบังคับที่ DB ด้วย: เดิม trigger จองแต้ม (v67) เช็คแค่ points_enabled
--    → พอเปิดโชว์แต้ม ลูกค้ายิง REST ใส่ points_redeemed เองได้ทั้งที่แอปยังไม่เปิดให้ใช้แต้ม
--    ตอนนี้ต้อง points_enabled = true **และ** app_config 'points_redeem' = {"enabled": true}
-- 2) สลิปที่ถูกปฏิเสธแล้วส่งซ้ำด้วย id เดิม: แถวจองแต้มเดิมยังอยู่ → insert ใหม่ถูก "do nothing" = ไม่หักแต้ม
--    แต่ตอนอนุมัติหนี้ถูกลด = ลดฟรี → ตอนนี้ id ที่เคยจองแต้มแล้วใช้ซ้ำไม่ได้
-- 3) (บั๊กเดิมก่อนระบบแต้ม) ลูกค้าสร้างแถว coupon_grants ของตัวเองสถานะ 'used' ให้คูปองไหนก็ได้ แล้วเอาไปใส่ในสลิป
--    → guard เดิมเช็คแค่ "grant เป็นของตัวเอง" = ปลอมคูปอง / ใช้คูปองใบเดิมซ้ำได้
--    ตอนนี้: ลูกค้าสร้าง grant ใหม่ไม่ได้ (แก้ได้เฉพาะแถวที่แอดมินมอบ: active → used) + สลิป/ออเดอร์ต้องอ้าง grant
--    ที่ "ใช้กับรายการนี้" จริง และยังไม่ถูกใช้กับรายการอื่น
-- ลำดับเซฟของแอป: coupon_grants (ตั้ง used + ticket_id/order_id) เซฟก่อน orders / remaining_payments เสมอ → เช็คได้
-- ============================================================================

-- ── 1+2) จองแต้ม: remaining_payments ────────────────────────────────────────
create or replace function ryuma_points_hold_rp()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_uid text; v_bal int; v_min int; v_cap int; v_on boolean; v_due numeric; v_owner text; v_redeem boolean;
begin
  if coalesce(new.points_redeemed, 0) <= 0 then return new; end if;
  if exists (select 1 from remaining_payments r where r.id = new.id) then return new; end if; -- upsert ซ้ำ ไม่จองซ้ำ
  if exists (select 1 from point_ledger e where e.id = 'pl-redeem-' || new.id) then
    raise exception 'ryuma: สลิปนี้เคยจองแต้มไปแล้ว — กรุณาส่งสลิปใหม่';
  end if;
  v_uid := case when is_app_admin() then new.user_id else app_user_id() end;
  select points_enabled, points_min_redeem, points_max_per_piece_pre into v_on, v_min, v_cap from shop_settings where id = 'default';
  if not coalesce(v_on, false) then raise exception 'ryuma: ระบบแต้มยังไม่เปิดใช้'; end if;
  select (value -> 'enabled') = 'true'::jsonb into v_redeem from app_config where key = 'points_redeem';
  if not coalesce(v_redeem, false) then raise exception 'ryuma: ยังไม่เปิดให้ใช้แต้มตัดยอด'; end if;
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
    on conflict (id) do nothing; -- ส่งซ้ำพร้อมกัน (retry หลัง timeout) — id เก่าที่ใช้ซ้ำถูกดักด้านบนแล้ว
  return new;
end $$;

-- ── 1+2) จองแต้ม: orders (พร้อมส่ง) ──────────────────────────────────────────
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
  if new.points_redeemed > coalesce(v_cap, 400) then raise exception 'ryuma: ใช้แต้มได้สูงสุด % ต่อออเดอร์', coalesce(v_cap, 400); end if;
  if new.points_redeemed < coalesce(v_min, 50) then raise exception 'ryuma: ใช้แต้มขั้นต่ำ %', coalesce(v_min, 50); end if;
  perform pg_advisory_xact_lock(hashtextextended('ryuma_points:' || v_uid, 0));
  select coalesce(sum(delta), 0) into v_bal from point_ledger where user_id = v_uid;
  if new.points_redeemed > v_bal then raise exception 'ryuma: แต้มไม่พอ (คงเหลือ % แต้ม — อาจมีสลิปอื่นจองแต้มอยู่)', v_bal; end if;
  insert into point_ledger(id, user_id, delta, kind, ref_type, ref_id, note, created_by)
    values ('pl-redeem-' || new.id, v_uid, -new.points_redeemed, 'redeem_order', 'order', new.id,
            'ใช้แต้มลดของพร้อมส่ง ' || new.points_redeemed || ' แต้ม (รอตรวจสลิป)', 'system')
    on conflict (id) do nothing; -- ส่งซ้ำพร้อมกัน (retry หลัง timeout) — id เก่าที่ใช้ซ้ำถูกดักด้านบนแล้ว
  return new;
end $$;

-- ── 3a) coupon_grants: ลูกค้าสร้างแถวใหม่ไม่ได้ · แก้ได้แค่ active → used ของแถวตัวเอง ─────────
create or replace function ryuma_guard_coupon_grant() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  if is_app_admin() then return new; end if;
  if TG_OP = 'INSERT' then
    -- upsert ของแถวที่แอดมินมอบไว้แล้ว (แอปเซฟแบบ insert … on conflict) → ให้ด่าน UPDATE คุม
    if exists (select 1 from coupon_grants g where g.id = new.id) then return new; end if;
    raise exception 'ryuma: คูปองมอบได้เฉพาะแอดมิน';
  end if;
  -- ใช้คูปอง: active → used เท่านั้น · ห้ามย้ายเจ้าของ/คูปอง
  if old.status = 'active' and new.status = 'used' then
    new.coupon_id  := old.coupon_id;
    new.user_id    := old.user_id;
    new.granted_at := old.granted_at;
    return new;
  end if;
  -- อย่างอื่น (ส่งซ้ำแถวเดิม / revoked → used / แก้ ticket_id ของใบที่ใช้แล้ว) = ไม่เปลี่ยนอะไร (ไม่ raise กันเซฟล้มทั้งก้อน)
  return old;
end $$;

drop trigger if exists coupon_grants_guard on coupon_grants;
create trigger coupon_grants_guard before insert or update on coupon_grants
  for each row execute function ryuma_guard_coupon_grant();

-- ── 3b) guard remaining_payments (แทน v67): คูปองต้องเป็น grant ที่ "ใช้กับใบนี้" และยังไม่ถูกใช้กับสลิปอื่น ──
create or replace function ryuma_guard_remaining()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_uid text := app_user_id(); v_val numeric; v_scope text; v_active boolean; v_status text; v_ticket text;
begin
  if is_app_admin() then return new; end if;
  if TG_OP = 'INSERT' then
    if exists (select 1 from remaining_payments r where r.id = new.id) then return new; end if;
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
  new.status          := old.status;
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

-- ── 3c) guard orders (แทน v67): คูปองต้องเป็น grant ที่ "ใช้กับออเดอร์นี้" + scope พร้อมส่ง + ไม่ซ้ำออเดอร์อื่น ──
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

-- ตรวจหลังรัน (ไม่บังคับ):
-- select proname from pg_proc where proname in ('ryuma_points_hold_rp','ryuma_points_hold_order','ryuma_guard_coupon_grant','ryuma_guard_remaining','ryuma_guard_orders');
-- select value from app_config where key = 'points_redeem';   -- ไม่มีแถว หรือ {"enabled":false} = ปิดใช้แต้มที่ DB ด้วย
-- ก่อนกดเปิดตัว: ต้องไม่มีแถว (แถวคะแนนที่ id ไม่ตรงรูปแบบ จะทำให้การเซฟแถวย้อนหลังล้ม)
-- select id from point_ledger where kind = 'earn_ticket' and id <> 'pl-earn-' || ref_id;
