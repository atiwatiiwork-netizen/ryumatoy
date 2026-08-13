-- ============================================================================
-- Ryuma — v62: สลิปส่วนต่างที่ "อนุมัติแล้ว" ต้องรอดจากการลบตั๋ว (หลักฐานเงินเข้า)
-- วางใน SQL Editor แล้วกด Run · รันซ้ำได้ ไม่ทำข้อมูลเสีย
--
-- ปัญหา: remaining_payments.ticket_id เดิมเป็น ON DELETE CASCADE — แอดมินลบตั๋ว 1 ใบ
-- (เช่น ลบใบซ้ำ/ยกเลิกรายการ) เซิร์ฟเวอร์จะลบสลิปส่วนต่างของตั๋วนั้นทิ้ง "ทุกใบ" รวมทั้ง
-- ใบที่อนุมัติแล้ว = หลักฐานว่าเงินเข้าจริงหายไปเงียบๆ รายงานรายได้เดือนย้อนหลังหดลง
-- (โค้ดฝั่งแอป 2026-08-08 เก็บใบที่อนุมัติแล้วไว้ตอนลบ แต่ cascade ฝั่ง DB ลบทับอยู่ดี)
--
-- แก้: เปลี่ยนเป็น ON DELETE SET NULL — ลบตั๋วแล้วแถวสลิปยังอยู่ (ticket_id ว่าง)
-- ยอดเงินยังถูกนับในรายงานเหมือนเดิม · สลิปที่ยังไม่ตรวจ (pending) ฝั่งแอปลบให้เองอยู่แล้ว
-- ============================================================================

alter table remaining_payments
  drop constraint if exists remaining_payments_ticket_id_fkey;

alter table remaining_payments
  add constraint remaining_payments_ticket_id_fkey
  foreign key (ticket_id) references preorder_tickets(id) on delete set null;

-- ── ตรวจหลังรัน (ไม่บังคับ) — confdeltype ต้องเป็น 'n' (SET NULL) ────────────
-- select conname, confdeltype from pg_constraint
--   where conname = 'remaining_payments_ticket_id_fkey';
