-- ============================================================================
-- v57 (2026-07-26): นัดชำระเป็นงานแอดมิน — แอดมินออกนัดให้ลูกค้า ลูกค้ากดจ่าย
-- รันทั้งไฟล์ใน Supabase SQL Editor (ต้องรัน v56 ก่อน)
-- ============================================================================

-- แอดมินคนไหนออกนัดใบนี้ + ออเดอร์ที่ลูกค้าจ่ายนัดนี้ (ตามรอยได้ครบเส้น)
alter table payment_plans add column if not exists created_by text;
alter table payment_plans add column if not exists order_id   text;

create index if not exists payment_plans_user_idx on payment_plans (user_id, status);

-- ── หมายเหตุเรื่อง RLS (สำคัญ — อ่านก่อนคิดจะรัดให้แน่นกว่านี้) ──────────────
-- policy `plans_own` (v56) ยังเป็น `for all` เหมือนเดิม = ลูกค้า insert แถวของตัวเองได้
-- **ห้ามตัดสิทธิ์ INSERT ของลูกค้าออก** แม้ฟีเจอร์นี้จะเป็น "แอดมินออกนัดให้" ก็ตาม เพราะ:
--   adapter เซฟด้วย `upsert(row)` = INSERT ... ON CONFLICT DO UPDATE
--   → ถ้าไม่มีสิทธิ์ INSERT ต่อให้แถวมีอยู่แล้ว Postgres ก็ปฏิเสธทั้งคำสั่ง
--   → ตอนลูกค้ากดจ่าย (markPlanPaid) หรือกดยกเลิกนัด การเซฟจะพังทั้งรอบ
--      = ตระกูลบั๊ก "ข้อมูลหาย" ตัวเดียวกับเคสคูปอง 2026-07-25 (ดู memory ryuma-bugs)
-- การบังคับ "แอดมินเท่านั้น" อยู่ที่ mutation `createPaymentPlan` (เช็ค is_admin)
-- และมีคอลัมน์ `created_by` ไว้ตรวจย้อนหลังว่านัดใบไหนไม่ได้ออกโดยแอดมิน:
--   select id, user_id, created_by, amount, due_date from payment_plans where created_by is null;
