-- ============================================================================
-- Ryuma — v87: ค่าส่งเพิ่มตามช่วงต้นทุน (เจ้าของ 2026-10-13: เปลี่ยนมาส่งรถ เรทเดิมขาดทุน)
-- รันไฟล์นี้ไฟล์เดียว · รันซ้ำได้ (add column if not exists / coalesce) · ไม่แก้ราคาสินค้าใดๆ
--
--   สูตรใหม่ (คิดในแอป · domain/services/pricing.ts):
--     ราคา = ฐานบาท + (หยวน − ฐานหยวน) × บาทต่อหยวน + ค่าส่งเพิ่ม
--     ค่าส่งเพิ่ม: ต้นทุน < 329¥ → +0 (288–328 เท่าเดิม) · ตั้งแต่ 329¥ → +40 · ตั้งแต่ 500¥ → +80 (แทนขั้น 1)
--   ไฟล์นี้แค่เพิ่มคอลัมน์ตั้งค่า 4 ตัวบน shop_settings (แอดมินแก้ได้ที่ /admin/payment)
--   ราคาสินค้าเดิม "ไม่ถูกแตะ" ที่นี่ — แอปจะปรับเฉพาะพรีที่เปิดรับและยังไม่มีคนพรี ตอนแอดมินกดปุ่ม/บันทึกสูตร
--   ก่อนรัน: แอปใช้ค่าตั้งต้นเดียวกันอยู่แล้ว (อ่านไม่เจอคอลัมน์ → fallback) · ที่เซฟไม่ได้คือ "แก้ตัวเลข 4 ช่องนี้" เท่านั้น
-- ============================================================================

alter table shop_settings add column if not exists surcharge_from_yuan_1 numeric default 329;
alter table shop_settings add column if not exists surcharge_baht_1 numeric default 40;
alter table shop_settings add column if not exists surcharge_from_yuan_2 numeric default 500;
alter table shop_settings add column if not exists surcharge_baht_2 numeric default 80;

update shop_settings set
  surcharge_from_yuan_1 = coalesce(surcharge_from_yuan_1, 329),
  surcharge_baht_1 = coalesce(surcharge_baht_1, 40),
  surcharge_from_yuan_2 = coalesce(surcharge_from_yuan_2, 500),
  surcharge_baht_2 = coalesce(surcharge_baht_2, 80)
where id = 'default';

-- ── ตรวจหลังรัน: ต้องได้ cols = 4 และ ok = true (แถวตั้งค่ามีค่าครบ 4 ช่อง)
select
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'shop_settings'
      and column_name in ('surcharge_from_yuan_1', 'surcharge_baht_1', 'surcharge_from_yuan_2', 'surcharge_baht_2')) as cols,
  (select surcharge_from_yuan_1 is not null and surcharge_baht_1 is not null and surcharge_from_yuan_2 is not null and surcharge_baht_2 is not null
     from shop_settings where id = 'default') as ok;
