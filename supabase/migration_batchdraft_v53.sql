-- v53 · รอบพิเศษแบบร่าง (draft/publish) — ไล่เก็บใบพรีเก่าเข้าระบบ (2026-07-20)
-- published: null/true = ขายอยู่หน้าร้าน (รอบเดิมทั้งหมดไม่กระทบ), false = ร่าง (มอบตั๋วก่อน ค่อยกดเปิดขาย)
-- ปลอดภัย: add column if not exists — รันซ้ำได้ ไม่แตะข้อมูลเดิม

alter table product_batches add column if not exists published boolean;
