-- v54 (2026-07-23): หาของเลือกจาก SKU ที่เคยมีในระบบ (concept "พรีเก่า = ฐานข้อมูลหาของ")
-- ลูกค้าเลือกสินค้าเดิม → ระบบเติมค่าย/เรื่อง/รูปให้ และผูกอ้างอิงไว้ที่คำขอ
alter table sourcing_requests add column if not exists source_product_id text;
