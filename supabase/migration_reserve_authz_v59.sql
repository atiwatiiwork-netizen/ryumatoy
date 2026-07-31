-- ============================================================================
-- Ryuma — v59: ปิดช่องโหว่ RPC จองสต๊อก (audit 2026-07-30). วางใน SQL Editor แล้วกด Run
-- รันซ้ำได้ ไม่ทำข้อมูลเสีย · ลายเซ็นเหมือนเดิมเป๊ะ (p_id text → json) จึงเป็นการ "ทับของเดิม"
-- ไม่ใช่สร้างฟังก์ชันซ้อน — โค้ดฝั่งแอปไม่ต้องแก้อะไรเลย
--
-- ปัญหาที่แก้:
--  1) _pay / _confirm / _release เดิมไม่ตรวจว่าใครเรียก → ถ้ารู้ id ใบจอง (uuid) คนอื่นสั่ง
--     "ปล่อยของ" ของคนที่กำลังจ่ายเงินอยู่ได้ = แย่งของกันได้ในวันของ hot
--     ใหม่: เจ้าของใบจอง หรือ แอดมิน เท่านั้น
--  2) _pay เดิมปลุกใบจองที่ "หมดอายุไปแล้ว" กลับมาเป็น paid (กันของถาวร)
--     → ของที่ควรหลุดคืนให้คนอื่นแล้ว ถูกดึงกลับเงียบ ๆ. ใหม่: หมดอายุแล้ว pay ไม่ได้
--
-- หมายเหตุ: ใช้ app_user_id() (v20) + is_app_admin() (v21) ที่มีอยู่แล้ว
-- ============================================================================

create or replace function ryuma_reserve_pay(p_id text)
returns json language plpgsql security definer set search_path = public, extensions as $$
declare r stock_reservations;
begin
  select * into r from stock_reservations where id = p_id for update;
  if not found then return json_build_object('ok', false, 'error', 'not_found'); end if;
  if not (r.user_id = app_user_id() or is_app_admin()) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;
  if r.status = 'paid' then return json_build_object('ok', true); end if;   -- กดซ้ำ = ผ่าน
  if r.status <> 'active' then return json_build_object('ok', false, 'error', 'not_active'); end if;
  -- ⚠ หมดอายุแล้วห้ามปลุกกลับ — ของหลุดไปให้คนอื่นตามกติกาแล้ว
  if r.reserved_until is not null and r.reserved_until <= now() then
    return json_build_object('ok', false, 'error', 'expired');
  end if;
  update stock_reservations set status = 'paid', reserved_until = null where id = p_id;
  return json_build_object('ok', true);
end $$;

create or replace function ryuma_reserve_confirm(p_id text)
returns json language plpgsql security definer set search_path = public, extensions as $$
declare r stock_reservations;
begin
  select * into r from stock_reservations where id = p_id for update;
  if not found then return json_build_object('ok', false, 'error', 'not_found'); end if;
  -- แอดมินอนุมัติสลิป · หรือลูกค้ายืนยันออเดอร์ที่ไม่ต้องโอน (ยศ Diamond / คูปองคุมเต็ม) ของตัวเอง
  if not (is_app_admin() or r.user_id = app_user_id()) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;
  if r.status = 'confirmed' then return json_build_object('ok', true); end if;
  update stock_reservations set status = 'confirmed', reserved_until = null where id = p_id;
  return json_build_object('ok', true);
end $$;

create or replace function ryuma_reserve_release(p_id text)
returns json language plpgsql security definer set search_path = public, extensions as $$
declare r stock_reservations;
begin
  select * into r from stock_reservations where id = p_id for update;
  if not found then return json_build_object('ok', false, 'error', 'not_found'); end if;
  if not (r.user_id = app_user_id() or is_app_admin()) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;
  if r.status in ('released', 'confirmed') then return json_build_object('ok', true); end if;
  update stock_reservations set status = 'released', reserved_until = null where id = p_id;
  return json_build_object('ok', true);
end $$;

-- สิทธิ์เรียกเหมือนเดิม (ตัวฟังก์ชันตรวจเองแล้ว)
grant execute on function ryuma_reserve_pay(text)     to anon, authenticated;
grant execute on function ryuma_reserve_confirm(text) to anon, authenticated;
grant execute on function ryuma_reserve_release(text) to anon, authenticated;

-- ── ตรวจหลังรัน (ไม่บังคับ) — ต้องได้ 3 แถว ไม่มีตัวซ้ำ ────────────────────
-- select proname, pg_get_function_identity_arguments(oid) as args
--   from pg_proc where proname in ('ryuma_reserve_pay','ryuma_reserve_confirm','ryuma_reserve_release')
--   order by proname;
