-- v52 · การรับของ (delivery choice) — ryuma delivery spec 2026-07-19
-- ลูกค้าเลือกวิธีรับของหลังจ่ายครบ (ส่งตามที่อยู่ / ที่อยู่ใหม่ / เรียกรถเข้ารับ / มารับเอง)
-- เก็บเป็น jsonb ก้อนเดียวบนตั๋ว: {method, name?, phone?, address?, requested_at, accepted_at?, closed_at?}
-- ปลอดภัย: add column if not exists — ไม่แตะข้อมูลเดิม, รันซ้ำได้

alter table preorder_tickets add column if not exists delivery jsonb;
