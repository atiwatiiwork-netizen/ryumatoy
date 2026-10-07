-- ============================================================================
-- Ryuma — v81 ไลน์ (พรียกไลน์) · วางใน Supabase SQL Editor แล้วกด Run · รันซ้ำได้ (idempotent)
-- ไม่พึ่ง v80 (รันก่อนหรือหลัง v80 ก็ได้)
--
-- 1) ตาราง product_lines — 1 แถว = 1 ไลน์ (เรื่อง × ค่าย) + รูปหมู่ + รายชื่อตัวละคร (members jsonb)
--    ⚠ ไม่มีคอลัมน์สถานะ: ป้ายบนรูปคำนวณสดจากสินค้า/สต๊อก/รอบพิเศษในแอป (domain/services/lines.ts)
--    members = [{ id, name, image_url?, product_ids: text[], manual_state?: 'preorder'|'stock'|'sourcing',
--                 pin_x?: 0-100, pin_y?: 0-100 }]  ลำดับใน array = เลข 1, 2, 3 บนรูป
-- 2) ryuma_lines_open() — อ่านสวิตช์ใหญ่ app_config 'lines_public' (ไม่มีแถว = ปิด)
-- 3) RLS: แอดมินอ่าน/เขียนได้ทุกแถว · สมาชิกที่อนุมัติแล้วอ่านได้เฉพาะไลน์ active และตอนสวิตช์ใหญ่เปิด
--    (สวิตช์ปิด = ลูกค้าดึงข้อมูลไลน์ไม่ได้เลยแม้ยิง API ตรง) · anon อ่านไม่ได้
-- ============================================================================

create table if not exists product_lines (
  id          text primary key,
  maker_id    text not null,
  franchise_id text,
  name        text not null default '',
  cover_url   text,
  note        text,
  members     jsonb not null default '[]'::jsonb,
  active      boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- members ต้องเป็น array เสมอ (กันแถวพังจากการแก้มือ)
do $$ begin
  alter table product_lines add constraint product_lines_members_array check (jsonb_typeof(members) = 'array');
exception when duplicate_object then null; end $$;

-- สวิตช์ใหญ่ — security definer: policy ไม่ต้องพึ่งสิทธิ์อ่าน app_config ของคนเรียก
-- (value->>'enabled') = 'true' แทนการ cast เป็น boolean: ค่าแปลกๆ ใน app_config ต้องไม่ทำให้ select ของลูกค้าพังทั้งตาราง
create or replace function ryuma_lines_open()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select (value ->> 'enabled') = 'true' from app_config where key = 'lines_public'), false);
$$;

alter table product_lines enable row level security;

drop policy if exists product_lines_read on product_lines;
create policy product_lines_read on product_lines for select
  using (is_app_admin() or (is_app_approved() and active and ryuma_lines_open()));

drop policy if exists product_lines_admin on product_lines;
create policy product_lines_admin on product_lines for all
  using (is_app_admin()) with check (is_app_admin());

-- ── ตรวจหลังรัน (ไม่บังคับ) ──
-- select count(*) from product_lines;          -- แอดมิน: ได้ตัวเลข (0 ก็ถูก) ไม่ error
-- select ryuma_lines_open();                    -- false จนกว่าจะกดเปิดในหน้าแอดมิน › ไลน์
