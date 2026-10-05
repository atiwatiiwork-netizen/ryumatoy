-- Ryuma - v80: รอบ 1 ของ "ตรวจหาบัค" 2026-10-05 (ส่วนฐานข้อมูล) — ปลอดภัยรันซ้ำได้
--
-- 1) guard users: ลูกค้าที่ยังไม่มีเบอร์ (สมัครผ่าน Facebook) ตั้งเบอร์ "ครั้งแรก" ได้ — กติกาของ v58 ที่หายไปตอน v64 แล้ว v65/v74 ลอกต่อกันมา
--    เดิม ProfileGate ส่งเบอร์+ที่อยู่ในรอบเดียวแล้วถูกปฏิเสธทั้งก้อน → ลูกค้าติดหน้ากรอกที่อยู่ตลอด (audit 1005 #7)
--    เบอร์ที่ "มีแล้ว" ยังเปลี่ยนเองไม่ได้เหมือนเดิม (เบอร์ = ตัวตนล็อกอิน)
-- 2) ด่านหาของ (v44) + ด่านคูปอง (v39): เติมคำนำหน้า ryuma: ให้ข้อความปฏิเสธ — แอปใช้คำนำหน้านี้แยก "ปฏิเสธถาวร" ออกจาก "เน็ตสะดุด"
--    เดิมไม่มี → แอปวนส่งซ้ำทุก 5 วิ และ reload({safe}) บล็อกปุ่มจ่ายเงิน/อนุมัติสลิปทั้งแท็บจนกว่าจะรีเฟรช (audit 1005 #3)
--    ตรรกะของด่านไม่เปลี่ยน แค่ข้อความ

-- ─────────────────────────────────────────────────────────────────────────────
-- 1) guard users (ทับ v74) — + เบอร์ครั้งแรก
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
     -- เบอร์: ตั้งครั้งแรกได้ (ยังไม่มี) · มีแล้วห้ามเปลี่ยนเอง (v58 → หายไปตอน v64 → คืนใน v80)
     or (new.phone is distinct from old.phone and coalesce(old.phone, '') <> '')
     or new.fb_link     is distinct from old.fb_link
     or new.pin_reset   is distinct from old.pin_reset
     or new.suspended   is distinct from old.suspended
  then raise exception 'ryuma: not allowed to modify protected user columns'; end if;
  return new;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2a) ด่านหาของ (ทับ v44) — ข้อความมีคำนำหน้า ryuma:
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function ryuma_guard_sourcing() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  if is_app_admin() then return new; end if;
  if tg_op = 'INSERT' then
    if new.status <> 'requested' or new.price is not null or new.deposit is not null
       or new.approved_at is not null or new.product_id is not null then
      raise exception 'ryuma: คำขอหาของเริ่มได้แค่สถานะ "ขอให้หา" เท่านั้น';
    end if;
    return new;
  end if;
  -- UPDATE by owner: allow quoted->paid (slip attach) and ->expired; quote fields must not change
  if new.price is distinct from old.price or new.deposit is distinct from old.deposit
     or new.transport is distinct from old.transport or new.expires_at is distinct from old.expires_at
     or new.approved_at is distinct from old.approved_at or new.product_id is distinct from old.product_id then
    raise exception 'ryuma: ใบเสนอราคาแก้ได้เฉพาะแอดมิน';
  end if;
  if new.status is distinct from old.status
     and not (old.status = 'quoted' and new.status = 'paid')
     and not (new.status = 'expired' and old.status in ('quoted','unavailable')) then
    raise exception 'ryuma: เปลี่ยนสถานะคำขอหาของแบบนี้ไม่ได้ (รีเฟรชหน้าแล้วดูสถานะล่าสุด)';
  end if;
  return new;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2b) ด่านคูปอง (ทับ v39) — ข้อความมีคำนำหน้า ryuma:
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function ryuma_guard_coupon_grant() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  -- only admins may issue or hold an ACTIVE grant; a customer may only flip their
  -- own grant to 'used' / 'revoked' (redeem). blocks self-granting a usable coupon.
  if not is_app_admin() and coalesce(new.status, 'active') = 'active' then
    raise exception 'ryuma: คูปองออกได้เฉพาะแอดมิน';
  end if;
  return new;
end $$;

-- ── ตรวจหลังรัน (ไม่บังคับ) ──────────────────────────────────────────────────
-- select prosrc like '%coalesce(old.phone%' from pg_proc where proname = 'guard_user_columns';   -- true
-- select count(*) from pg_proc where proname in ('ryuma_guard_sourcing','ryuma_guard_coupon_grant') and prosrc like '%ryuma:%'; -- 2
