-- ============================================================================
-- Ryuma — v82 ลูกค้านอกระบบ: รายการ "รอแจ้งเลขพัสดุ" + ประวัติที่แจ้งแล้ว
-- วางใน Supabase SQL Editor แล้วกด Run · รันซ้ำได้ (idempotent) · ไม่พึ่ง v80/v81
--
-- ที่มา (เจ้าของ 2026-10-10): อ่านใบเสร็จขนส่งแล้วใบที่ "ไม่เจอในระบบ" = ลูกค้าที่ซื้อนอกแอป
-- ต้องเอาเลขพัสดุไปแจ้งในแชทเอง → อยากมีปุ่มติ๊ก "แจ้งแล้ว" และเก็บเป็นประวัติ
-- 1 แถว = 1 พัสดุ · id = '<ขนส่ง>:<เลขพัสดุ>' (อัปโหลดใบเสร็จเดิมซ้ำ = แถวเดิม ไม่ซ้ำ)
-- แอดมินอ่าน/เขียนได้เท่านั้น (ลูกค้า/anon มองไม่เห็น — มีชื่อ/เบอร์คนอื่น)
-- ============================================================================

create table if not exists external_parcels (
  id           text primary key,            -- '<carrier>:<waybill>'
  carrier      text not null,               -- jt | flash | kerry | ems
  waybill      text not null,
  name         text not null default '',    -- ชื่อผู้รับตามใบเสร็จ (OCR อาจเพี้ยน แก้ได้)
  phone        text not null default '',
  created_by   text,                        -- แอดมินที่อ่านใบเสร็จ
  created_at   timestamptz not null default now(),
  notified_at  timestamptz,                 -- กด ✓ แจ้งลูกค้าแล้ว เมื่อไหร่
  notified_by  text,
  dropped_at   timestamptz                  -- กด ✕ เอาออก (ไม่ต้องแจ้ง) — เก็บไว้ ไม่ลบ
);

alter table external_parcels enable row level security;

drop policy if exists external_parcels_admin on external_parcels;
create policy external_parcels_admin on external_parcels for all
  using (is_app_admin()) with check (is_app_admin());

-- ── ตรวจหลังรัน (ไม่บังคับ) ──
-- select count(*) from external_parcels;   -- แอดมิน: ได้ตัวเลข (0 ก็ถูก) ไม่ error
